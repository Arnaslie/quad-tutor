import { randomUUID } from "node:crypto";

import { and, asc, eq, exists, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  professor,
  term,
  tutorCourse,
  tutorProfile,
  user,
  verificationFile,
} from "@/server/db/schema";
import type { OperatorActor, TutorActor } from "@/server/modules/identity/actor";

import {
  PDF_TYPE,
  proofProblem,
  type ProofKind,
  type RejectionReason,
} from "./proof-rules";
import { proofStore } from "./proof-store";

export class VerificationError extends Error {}

export const PROOF_RETENTION_DAYS = 30;

const EXTENSION: Record<string, string> = {
  [PDF_TYPE]: "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function sniff(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return PDF_TYPE;
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}

const currentFile = and(
  eq(verificationFile.tutorCourseId, tutorCourse.id),
  isNull(verificationFile.supersededAt),
);

function hasCurrentProof() {
  return exists(db.select({ id: verificationFile.id }).from(verificationFile).where(currentFile));
}

export async function submitProof(params: {
  tutor: TutorActor;
  tutorCourseId: string;
  kind: ProofKind;
  files: Uint8Array[];
}): Promise<void> {
  const files = params.files.map((bytes) => ({
    bytes,
    type: sniff(bytes) ?? "unknown",
    size: bytes.byteLength,
  }));
  const problem = proofProblem(params.kind, files);
  if (problem) throw new VerificationError(problem);

  const campus = params.tutor.institutionId;
  const owned = and(
    eq(tutorCourse.id, params.tutorCourseId),
    eq(tutorCourse.tutorProfileId, params.tutor.tutorProfileId),
    inArray(tutorCourse.status, ["pending_verification", "rejected"]),
    exists(
      db
        .select({ id: course.id })
        .from(course)
        .where(and(eq(course.id, tutorCourse.courseId), eq(course.institutionId, campus))),
    ),
  );

  const claim = await db.select({ id: tutorCourse.id }).from(tutorCourse).where(owned).limit(1);
  if (!claim.at(0)) throw new VerificationError("That course is not waiting on proof.");

  const store = proofStore();
  const stored = files.map((file) => ({
    pathname: `verification/${campus}/${params.tutorCourseId}/${randomUUID()}.${EXTENSION[file.type]}`,
    contentType: file.type,
    sizeBytes: file.size,
    bytes: file.bytes,
  }));

  try {
    for (const file of stored) await store.put(file.pathname, file.bytes, file.contentType);

    await db.transaction(async (tx) => {
      const updated = await tx
        .update(tutorCourse)
        .set({
          status: "pending_verification",
          proofKind: params.kind,
          reviewedAt: null,
          reviewedByUserId: null,
          rejectionReason: null,
          decisionNotifiedAt: null,
        })
        .where(owned)
        .returning({ id: tutorCourse.id });
      if (updated.length === 0) {
        throw new VerificationError("That course is not waiting on proof.");
      }

      await tx
        .update(verificationFile)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(verificationFile.tutorCourseId, params.tutorCourseId),
            isNull(verificationFile.supersededAt),
          ),
        );
      await tx.insert(verificationFile).values(
        stored.map((file) => ({
          tutorCourseId: params.tutorCourseId,
          institutionId: campus,
          pathname: file.pathname,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
        })),
      );
    });
  } catch (error) {
    await store.del(stored.map((file) => file.pathname)).catch((cleanup) => {
      console.error("[verification] upload cleanup failed", cleanup);
    });
    throw error;
  }

  await purgeProofFiles(campus);
}

function decidableBy(operator: OperatorActor, tutorCourseId: string) {
  return and(
    eq(tutorCourse.id, tutorCourseId),
    eq(tutorCourse.status, "pending_verification"),
    hasCurrentProof(),
    exists(
      db
        .select({ id: tutorProfile.id })
        .from(tutorProfile)
        .innerJoin(course, eq(course.institutionId, tutorProfile.institutionId))
        .where(
          and(
            eq(tutorProfile.id, tutorCourse.tutorProfileId),
            eq(course.id, tutorCourse.courseId),
            inArray(tutorProfile.institutionId, operator.operatorInstitutionIds),
            ne(tutorProfile.userId, operator.userId),
          ),
        ),
    ),
  );
}

async function decide(
  operator: OperatorActor,
  tutorCourseId: string,
  outcome:
    | { status: "active" }
    | { status: "rejected"; reason: RejectionReason },
): Promise<void> {
  if (operator.operatorInstitutionIds.length === 0) {
    throw new VerificationError("That claim is not waiting on a decision.");
  }

  const now = new Date();
  const decided = await db
    .update(tutorCourse)
    .set({
      status: outcome.status,
      verifiedAt: outcome.status === "active" ? now : null,
      rejectionReason: outcome.status === "rejected" ? outcome.reason : null,
      reviewedAt: now,
      reviewedByUserId: operator.userId,
      decisionNotifiedAt: null,
    })
    .where(decidableBy(operator, tutorCourseId))
    .returning({ tutorProfileId: tutorCourse.tutorProfileId });

  const row = decided.at(0);
  if (!row) throw new VerificationError("That claim is not waiting on a decision.");

  const campus = await db
    .select({ institutionId: tutorProfile.institutionId })
    .from(tutorProfile)
    .where(eq(tutorProfile.id, row.tutorProfileId))
    .limit(1);
  await purgeProofFiles(campus[0].institutionId).catch((error) => {
    console.error(`[verification] purge after decision on ${tutorCourseId} failed`, error);
  });
}

export function verifyClaim(params: {
  operator: OperatorActor;
  tutorCourseId: string;
}): Promise<void> {
  return decide(params.operator, params.tutorCourseId, { status: "active" });
}

export function rejectClaim(params: {
  operator: OperatorActor;
  tutorCourseId: string;
  reason: RejectionReason;
}): Promise<void> {
  return decide(params.operator, params.tutorCourseId, {
    status: "rejected",
    reason: params.reason,
  });
}

export async function purgeProofFiles(institutionId: string): Promise<number> {
  const cutoff = new Date(Date.now() - PROOF_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const doomed = await db
    .select({ id: verificationFile.id, pathname: verificationFile.pathname })
    .from(verificationFile)
    .innerJoin(tutorCourse, eq(tutorCourse.id, verificationFile.tutorCourseId))
    .where(
      and(
        eq(verificationFile.institutionId, institutionId),
        or(
          isNotNull(verificationFile.supersededAt),
          ne(tutorCourse.status, "pending_verification"),
          lt(verificationFile.uploadedAt, cutoff),
        ),
      ),
    );
  if (doomed.length === 0) return 0;

  await proofStore().del(doomed.map((file) => file.pathname));
  await db.delete(verificationFile).where(
    inArray(
      verificationFile.id,
      doomed.map((file) => file.id),
    ),
  );
  return doomed.length;
}

export type VerificationQueueItem = {
  tutorCourseId: string;
  tutorName: string;
  tutorEmail: string;
  courseCode: string | null;
  courseTitle: string;
  gradeEarned: string;
  takenTermName: string;
  professorName: string | null;
  proofKind: ProofKind | null;
  submittedAt: Date;
  files: { id: string; contentType: string }[];
};

export async function verificationQueue(
  operator: OperatorActor,
): Promise<VerificationQueueItem[]> {
  if (operator.operatorInstitutionIds.length === 0) return [];
  for (const campus of operator.operatorInstitutionIds) {
    await purgeProofFiles(campus).catch((error) => {
      console.error("[verification] purge failed", error);
    });
  }

  const rows = await db
    .select({
      tutorCourseId: tutorCourse.id,
      tutorName: user.name,
      tutorEmail: user.email,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      gradeEarned: tutorCourse.gradeEarned,
      takenTermName: term.name,
      professorName: professor.name,
      proofKind: tutorCourse.proofKind,
      fileId: verificationFile.id,
      contentType: verificationFile.contentType,
      uploadedAt: verificationFile.uploadedAt,
    })
    .from(tutorCourse)
    .innerJoin(verificationFile, currentFile)
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .innerJoin(term, eq(term.id, tutorCourse.takenTermId))
    .leftJoin(professor, eq(professor.id, tutorCourse.takenUnderProfessorId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        eq(tutorCourse.status, "pending_verification"),
        inArray(tutorProfile.institutionId, operator.operatorInstitutionIds),
        eq(course.institutionId, tutorProfile.institutionId),
        eq(verificationFile.institutionId, tutorProfile.institutionId),
        ne(tutorProfile.userId, operator.userId),
      ),
    )
    .orderBy(asc(verificationFile.uploadedAt), asc(verificationFile.id));

  const byClaim = new Map<string, VerificationQueueItem>();
  for (const row of rows) {
    const { fileId, contentType, uploadedAt, ...claim } = row;
    const item = byClaim.get(row.tutorCourseId) ?? { ...claim, submittedAt: uploadedAt, files: [] };
    item.files.push({ id: fileId, contentType });
    byClaim.set(row.tutorCourseId, item);
  }
  return [...byClaim.values()];
}

export async function proofFileFor(
  operator: OperatorActor,
  fileId: string,
): Promise<{ pathname: string; contentType: string } | null> {
  if (operator.operatorInstitutionIds.length === 0) return null;

  const rows = await db
    .select({ pathname: verificationFile.pathname, contentType: verificationFile.contentType })
    .from(verificationFile)
    .innerJoin(tutorCourse, eq(tutorCourse.id, verificationFile.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(verificationFile.id, fileId),
        isNull(verificationFile.supersededAt),
        eq(tutorCourse.status, "pending_verification"),
        inArray(verificationFile.institutionId, operator.operatorInstitutionIds),
        eq(tutorProfile.institutionId, verificationFile.institutionId),
        ne(tutorProfile.userId, operator.userId),
      ),
    )
    .limit(1);

  return rows.at(0) ?? null;
}

export async function readProof(pathname: string) {
  return proofStore().get(pathname);
}
