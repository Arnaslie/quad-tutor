import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseOffering,
  engagement,
  matchRequest,
  professor,
  reliabilityEvent,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { courseCodeAlias } from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { standingFrom, type Standing } from "@/server/modules/reliability/standing";

import { REQUEST_EXPIRY_HOURS } from "./candidates";

export class RequestError extends Error {}

export async function expireStaleRequests(): Promise<void> {
  await db
    .update(matchRequest)
    .set({ status: "expired", resolvedAt: new Date() })
    .where(and(eq(matchRequest.status, "pending"), lt(matchRequest.expiresAt, new Date())));
}

export async function standingFor(actor: Actor): Promise<Standing> {
  const facts = await db
    .select({ type: reliabilityEvent.type, occurredAt: reliabilityEvent.occurredAt })
    .from(reliabilityEvent)
    .where(eq(reliabilityEvent.userId, actor.userId));

  return standingFrom(facts);
}

export async function requestTutors(params: {
  actor: Actor;
  courseOfferingId: string;
  tutorCourseIds: string[];
}): Promise<{ created: number; limit: number }> {
  await expireStaleRequests();

  const standing = await standingFor(params.actor);
  const expiresAt = new Date(Date.now() + REQUEST_EXPIRY_HOURS * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    const pending = await tx
      .select({ id: matchRequest.id, tutorCourseId: matchRequest.tutorCourseId })
      .from(matchRequest)
      .where(
        and(
          eq(matchRequest.studentProfileId, params.actor.studentProfileId),
          eq(matchRequest.status, "pending"),
        ),
      )
      .for("update");

    if (pending.length >= standing.parallelAskLimit) {
      throw new RequestError(
        `You already have ${pending.length} requests out. Wait for one to come back.`,
      );
    }

    const alreadyAsked = new Set(pending.map((row) => row.tutorCourseId));
    const room = standing.parallelAskLimit - pending.length;

    const eligible = await tx
      .select({ id: tutorCourse.id })
      .from(tutorCourse)
      .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
      .innerJoin(courseOffering, eq(courseOffering.courseId, tutorCourse.courseId))
      .where(
        and(
          inArray(tutorCourse.id, params.tutorCourseIds),
          eq(tutorCourse.status, "active"),
          eq(courseOffering.id, params.courseOfferingId),
          eq(tutorProfile.institutionId, params.actor.institutionId),

          ne(tutorProfile.userId, params.actor.userId),
        ),
      );

    const toCreate = eligible
      .map((row) => row.id)
      .filter((id) => !alreadyAsked.has(id))
      .slice(0, room);

    if (toCreate.length === 0) return { created: 0, limit: standing.parallelAskLimit };

    await tx.insert(matchRequest).values(
      toCreate.map((tutorCourseId) => ({
        studentProfileId: params.actor.studentProfileId,
        tutorCourseId,
        courseOfferingId: params.courseOfferingId,
        expiresAt,
      })),
    );

    return { created: toCreate.length, limit: standing.parallelAskLimit };
  });
}

export async function acceptRequest(params: {
  tutor: TutorActor;
  requestId: string;
}): Promise<{ requestId: string }> {
  await expireStaleRequests();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: matchRequest.id,
        status: matchRequest.status,
        expiresAt: matchRequest.expiresAt,
        studentProfileId: matchRequest.studentProfileId,
        studentUserId: studentProfile.userId,
        courseOfferingId: matchRequest.courseOfferingId,
        tutorProfileId: tutorCourse.tutorProfileId,
      })
      .from(matchRequest)
      .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
      .innerJoin(studentProfile, eq(studentProfile.id, matchRequest.studentProfileId))
      .where(eq(matchRequest.id, params.requestId))
      .for("update")
      .limit(1);

    const request = rows.at(0);
    if (!request) throw new RequestError("That request no longer exists.");
    if (request.tutorProfileId !== params.tutor.tutorProfileId) {
      throw new RequestError("That request was not sent to you.");
    }
    if (request.status !== "pending") {
      throw new RequestError("That request has already been resolved.");
    }
    if (request.expiresAt.getTime() <= Date.now()) {
      throw new RequestError("That request expired.");
    }

    if (request.studentUserId === params.tutor.userId) {
      throw new RequestError("You cannot tutor yourself.");
    }

    const winner = await tx
      .select({ id: matchRequest.id })
      .from(matchRequest)
      .where(
        and(
          eq(matchRequest.studentProfileId, request.studentProfileId),
          eq(matchRequest.courseOfferingId, request.courseOfferingId),
          eq(matchRequest.status, "accepted"),
        ),
      )
      .limit(1);

    if (winner.at(0)) {
      throw new RequestError("Another tutor accepted this one first.");
    }

    const now = new Date();

    await tx
      .update(matchRequest)
      .set({ status: "accepted", resolvedAt: now })
      .where(eq(matchRequest.id, request.id));

    await tx
      .update(matchRequest)
      .set({ status: "withdrawn", resolvedAt: now })
      .where(
        and(
          eq(matchRequest.studentProfileId, request.studentProfileId),
          eq(matchRequest.courseOfferingId, request.courseOfferingId),
          eq(matchRequest.status, "pending"),
        ),
      );

    return { requestId: request.id };
  });
}

export async function declineRequest(params: {
  tutor: TutorActor;
  requestId: string;
}): Promise<void> {
  const updated = await db
    .update(matchRequest)
    .set({ status: "declined", resolvedAt: new Date() })
    .where(
      and(
        eq(matchRequest.id, params.requestId),
        eq(matchRequest.status, "pending"),
        sql`${matchRequest.tutorCourseId} in (
          select ${tutorCourse.id} from ${tutorCourse}
          where ${tutorCourse.tutorProfileId} = ${params.tutor.tutorProfileId}
        )`,
      ),
    )
    .returning({ id: matchRequest.id });

  if (!updated.at(0)) throw new RequestError("That request is no longer pending.");
}

export type StudentRequest = {
  id: string;
  status: "pending" | "accepted" | "declined" | "expired" | "withdrawn";
  expiresAt: Date;
  tutorName: string;
  courseCode: string;
  courseTitle: string;
  offeringId: string;
  section: string | null;
  professorName: string | null;

  expiresInMinutes: number;

  engagementId: string | null;
};

export async function requestsForStudent(actor: Actor): Promise<StudentRequest[]> {
  await expireStaleRequests();
  const now = Date.now();

  const rows = await db
    .select({
      id: matchRequest.id,
      status: matchRequest.status,
      expiresAt: matchRequest.expiresAt,
      tutorName: user.name,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      offeringId: matchRequest.courseOfferingId,
      section: courseOffering.section,
      professorName: professor.name,
      engagementId: engagement.id,
    })
    .from(matchRequest)
    .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .leftJoin(engagement, eq(engagement.matchRequestId, matchRequest.id))
    .innerJoin(courseOffering, eq(courseOffering.id, matchRequest.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(courseCodeAlias, eq(courseCodeAlias.courseId, course.id))
    .leftJoin(professor, eq(professor.id, courseOffering.professorId))
    .where(
      and(
        eq(matchRequest.studentProfileId, actor.studentProfileId),
        sql`${courseCodeAlias.validToTermId} is null`,
      ),
    )
    .orderBy(sql`${matchRequest.createdAt} desc`)
    .limit(50);

  return rows.map((row) => ({ ...row, expiresInMinutes: minutesUntil(row.expiresAt, now) }));
}

function minutesUntil(moment: Date, now: number): number {
  return Math.max(0, Math.round((moment.getTime() - now) / 60_000));
}

export type TutorInboxItem = {
  id: string;
  expiresAt: Date;
  studentName: string;
  courseCode: string;
  courseTitle: string;
  section: string | null;
  professorName: string | null;

  takenTermName: string;
  gradeEarned: string;

  expiresInMinutes: number;
};

export async function inboxForTutor(tutor: TutorActor): Promise<TutorInboxItem[]> {
  await expireStaleRequests();
  const now = Date.now();

  const takenTerm = term;

  const rows = await db
    .select({
      id: matchRequest.id,
      expiresAt: matchRequest.expiresAt,
      studentName: user.name,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      section: courseOffering.section,
      professorName: professor.name,
      takenTermName: takenTerm.name,
      gradeEarned: tutorCourse.gradeEarned,
    })
    .from(matchRequest)
    .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
    .innerJoin(takenTerm, eq(takenTerm.id, tutorCourse.takenTermId))
    .innerJoin(courseOffering, eq(courseOffering.id, matchRequest.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(courseCodeAlias, eq(courseCodeAlias.courseId, course.id))
    .leftJoin(professor, eq(professor.id, courseOffering.professorId))
    .innerJoin(studentProfile, eq(studentProfile.id, matchRequest.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .where(
      and(
        eq(tutorCourse.tutorProfileId, tutor.tutorProfileId),
        eq(matchRequest.status, "pending"),
        sql`${courseCodeAlias.validToTermId} is null`,
      ),
    )
    .orderBy(matchRequest.expiresAt);

  return rows.map((row) => ({ ...row, expiresInMinutes: minutesUntil(row.expiresAt, now) }));
}
