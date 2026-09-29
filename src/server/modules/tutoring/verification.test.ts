import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  demandSignal,
  institution,
  operator,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
  verificationFile,
} from "@/server/db/schema";
import type { OperatorActor, TutorActor } from "@/server/modules/identity/actor";
import {
  notifyCoveredSections,
  notifyVerificationDecisions,
} from "@/server/modules/notifications/dispatch";

import { proofStore } from "./proof-store";
import {
  VerificationError,
  proofFileFor,
  purgeProofFiles,
  rejectClaim,
  submitProof,
  verificationQueue,
  verifyClaim,
} from "./verification";

delete process.env.RESEND_API_KEY;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;

const run = randomUUID().slice(0, 8);
const PDF = new TextEncoder().encode("%PDF-1.7\n% test transcript\n%%EOF\n");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

type Campus = { institutionId: string; termId: string; courseIds: string[]; offeringIds: string[] };

const made = { institutions: [] as string[], users: [] as string[] };
let home: Campus;
let tutor: TutorActor;
let ops: OperatorActor;
let elsewhereOps: OperatorActor;
let studentProfileId: string;

async function campus(slug: string, courses: number): Promise<Campus> {
  const [inst] = await db
    .insert(institution)
    .values({
      name: `Test ${slug}`,
      slug: `test-${slug}-${run}`,
      emailDomain: `${slug}-${run}.test`,
      timezone: "America/Chicago",
    })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);

  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: "2026-01-01", endsOn: "2099-12-31" })
    .returning({ id: term.id });

  const courseIds: string[] = [];
  const offeringIds: string[] = [];
  for (let index = 0; index < courses; index += 1) {
    const [courseRow] = await db
      .insert(course)
      .values({ institutionId: inst.id, title: `Course ${index}`, department: "TEST" })
      .returning({ id: course.id });
    await db.insert(courseCodeAlias).values({ courseId: courseRow.id, code: `TST ${index}` });
    const [offering] = await db
      .insert(courseOffering)
      .values({ courseId: courseRow.id, termId: termRow.id, section: "001" })
      .returning({ id: courseOffering.id });
    courseIds.push(courseRow.id);
    offeringIds.push(offering.id);
  }

  return { institutionId: inst.id, termId: termRow.id, courseIds, offeringIds };
}

async function person(key: string, institutionId: string) {
  const id = `test_${key}_${run}`;
  await db.insert(user).values({ id, name: key, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db
    .insert(studentProfile)
    .values({ userId: id, institutionId })
    .returning({ id: studentProfile.id });
  return {
    userId: id,
    name: key,
    email: `${id}@example.test`,
    institutionId,
    studentProfileId: profile.id,
    tutorProfileId: null,
  };
}

async function claim(courseId: string): Promise<string> {
  const [row] = await db
    .insert(tutorCourse)
    .values({
      tutorProfileId: tutor.tutorProfileId,
      courseId,
      takenTermId: home.termId,
      gradeEarned: "A",
    })
    .returning({ id: tutorCourse.id });
  return row.id;
}

async function claimRow(id: string) {
  const [row] = await db.select().from(tutorCourse).where(eq(tutorCourse.id, id));
  return row;
}

async function currentFiles(id: string) {
  return db.select().from(verificationFile).where(eq(verificationFile.tutorCourseId, id));
}

before(async () => {
  home = await campus("home", 2);
  const away = await campus("away", 0);

  const tutorPerson = await person("tutor", home.institutionId);
  const [profile] = await db
    .insert(tutorProfile)
    .values({ userId: tutorPerson.userId, institutionId: home.institutionId })
    .returning({ id: tutorProfile.id });
  tutor = { ...tutorPerson, tutorProfileId: profile.id };

  const opsPerson = await person("ops", home.institutionId);
  await db.insert(operator).values({ userId: opsPerson.userId, institutionId: home.institutionId });
  ops = { ...opsPerson, operatorInstitutionIds: [home.institutionId] };

  const awayPerson = await person("away-ops", away.institutionId);
  await db.insert(operator).values({ userId: awayPerson.userId, institutionId: away.institutionId });
  elsewhereOps = { ...awayPerson, operatorInstitutionIds: [away.institutionId] };

  const student = await person("student", home.institutionId);
  studentProfileId = student.studentProfileId;
  await db
    .insert(demandSignal)
    .values({ studentProfileId, courseOfferingId: home.offeringIds[0] });
});

after(async () => {
  const institutions = made.institutions;
  const courseIds = (
    await db.select({ id: course.id }).from(course).where(inArray(course.institutionId, institutions))
  ).map((row) => row.id);

  await db.delete(verificationFile).where(inArray(verificationFile.institutionId, institutions));
  await db.delete(demandSignal).where(eq(demandSignal.studentProfileId, studentProfileId));
  await db.delete(tutorCourse).where(inArray(tutorCourse.courseId, courseIds));
  await db.delete(operator).where(inArray(operator.userId, made.users));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, made.users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, made.users));
  await db.delete(user).where(inArray(user.id, made.users));
  await db.delete(courseOffering).where(inArray(courseOffering.courseId, courseIds));
  await db.delete(courseCodeAlias).where(inArray(courseCodeAlias.courseId, courseIds));
  await db.delete(course).where(inArray(course.id, courseIds));
  await db.delete(term).where(inArray(term.institutionId, institutions));
  await db.delete(institution).where(inArray(institution.id, institutions));
  await db.$client.end();
});

test("approval activates the claim, deletes the proof and emails the waiting student once", async () => {
  const id = await claim(home.courseIds[0]);

  await assert.rejects(
    submitProof({ tutor, tutorCourseId: id, kind: "official_transcript", files: [PNG] }),
    VerificationError,
  );
  await submitProof({ tutor, tutorCourseId: id, kind: "official_transcript", files: [PDF] });

  const [file] = await currentFiles(id);
  assert.equal((await claimRow(id)).proofKind, "official_transcript");
  assert.ok(await proofStore().get(file.pathname));

  assert.equal((await verificationQueue(elsewhereOps)).length, 0);
  assert.equal(await proofFileFor(elsewhereOps, file.id), null);
  await assert.rejects(verifyClaim({ operator: elsewhereOps, tutorCourseId: id }), VerificationError);
  assert.equal(await notifyCoveredSections(home.institutionId), 0);

  assert.equal((await verificationQueue(ops)).length, 1);
  assert.ok(await proofFileFor(ops, file.id));
  await verifyClaim({ operator: ops, tutorCourseId: id });

  const approved = await claimRow(id);
  assert.equal(approved.status, "active");
  assert.ok(approved.verifiedAt);
  assert.equal(approved.reviewedByUserId, ops.userId);
  assert.equal((await currentFiles(id)).length, 0);
  assert.equal(await proofStore().get(file.pathname), null);

  assert.equal(await notifyCoveredSections(home.institutionId), 1);
  assert.equal(await notifyCoveredSections(home.institutionId), 0);
  assert.equal(await notifyVerificationDecisions(home.institutionId), 1);
  assert.equal(await notifyVerificationDecisions(home.institutionId), 0);
});

test("rejection records the reason and a re-upload returns the same row to pending", async () => {
  const id = await claim(home.courseIds[1]);
  await submitProof({ tutor, tutorCourseId: id, kind: "screenshot", files: [PNG, PNG] });
  assert.equal((await currentFiles(id)).length, 2);

  await rejectClaim({ operator: ops, tutorCourseId: id, reason: "unreadable" });
  const rejected = await claimRow(id);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectionReason, "unreadable");
  assert.equal(rejected.verifiedAt, null);
  assert.equal((await currentFiles(id)).length, 0);

  const env = process.env as Record<string, string | undefined>;
  const nodeEnv = env.NODE_ENV;
  env.NODE_ENV = "production";
  assert.equal(await notifyVerificationDecisions(home.institutionId), 0);
  env.NODE_ENV = nodeEnv;
  assert.equal((await claimRow(id)).decisionNotifiedAt, null);
  assert.equal(await notifyVerificationDecisions(home.institutionId), 1);

  await submitProof({ tutor, tutorCourseId: id, kind: "official_transcript", files: [PDF] });
  const again = await claimRow(id);
  assert.equal(again.status, "pending_verification");
  assert.equal(again.rejectionReason, null);
  assert.equal(again.reviewedAt, null);
  assert.equal(again.proofKind, "official_transcript");

  await db
    .update(verificationFile)
    .set({ uploadedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
    .where(eq(verificationFile.tutorCourseId, id));
  const [stale] = await currentFiles(id);
  assert.equal(await purgeProofFiles(home.institutionId), 1);
  assert.equal(await proofStore().get(stale.pathname), null);
  assert.equal((await claimRow(id)).status, "pending_verification");
});
