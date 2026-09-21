import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  professor,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";

export class SessionError extends Error {}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type Executor = typeof db | Tx;

export const tutorUser = alias(user, "tutor_user");

export type Participation = SessionContextRow & { role: "student" | "tutor" };

export type SessionContextRow = {
  sessionId: string;
  engagementId: string;
  scheduledAt: Date;
  durationMinutes: number;
  locationNote: string | null;
  status: "scheduled" | "completed" | "cancelled" | "disputed";
  resolution:
    | "both_confirmed"
    | "auto_released"
    | "disputed"
    | "resolved_attended"
    | "resolved_not_attended"
    | null;
  studentConfirmedAt: Date | null;
  tutorConfirmedAt: Date | null;
  studentDeniedAt: Date | null;
  tutorDeniedAt: Date | null;

  denialNote: string | null;
  confirmationWindowEndsAt: Date | null;
  studentProfileId: string;
  studentUserId: string;
  studentName: string;
  tutorProfileId: string;
  tutorUserId: string;
  tutorName: string;
  engagementStatus: "active" | "completed" | "refunded" | "cancelled";
  sessionsPurchased: number;
  pricePaidMinor: number;
  currency: string;

  courseId: string;
  courseCode: string | null;
  courseTitle: string;
  section: string | null;
  professorName: string | null;
  termName: string;
};

export function sessionContext(exec: Executor = db) {
  return exec
    .select({
      sessionId: sessionBooking.id,
      engagementId: sessionBooking.engagementId,
      scheduledAt: sessionBooking.scheduledAt,
      durationMinutes: sessionBooking.durationMinutes,
      locationNote: sessionBooking.locationNote,
      status: sessionBooking.status,
      resolution: sessionBooking.resolution,
      studentConfirmedAt: sessionBooking.studentConfirmedAt,
      tutorConfirmedAt: sessionBooking.tutorConfirmedAt,
      studentDeniedAt: sessionBooking.studentDeniedAt,
      tutorDeniedAt: sessionBooking.tutorDeniedAt,
      denialNote: sessionBooking.denialNote,
      confirmationWindowEndsAt: sessionBooking.confirmationWindowEndsAt,
      studentProfileId: studentProfile.id,
      studentUserId: studentProfile.userId,
      studentName: user.name,
      tutorProfileId: tutorProfile.id,
      tutorUserId: tutorProfile.userId,
      tutorName: tutorUser.name,
      engagementStatus: engagement.status,
      sessionsPurchased: engagement.sessionsPurchased,
      pricePaidMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
      courseId: course.id,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      section: courseOffering.section,
      professorName: professor.name,
      termName: term.name,
    })
    .from(sessionBooking)
    .innerJoin(engagement, eq(engagement.id, sessionBooking.engagementId))
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(user, eq(user.id, studentProfile.userId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(term, eq(term.id, courseOffering.termId))

    .leftJoin(
      courseCodeAlias,
      and(
        eq(courseCodeAlias.courseId, course.id),
        isNull(courseCodeAlias.validToTermId),
      ),
    )
    .leftJoin(professor, eq(professor.id, courseOffering.professorId));
}

export function onCampus(institutionId: string) {
  return and(
    eq(studentProfile.institutionId, institutionId),
    eq(tutorProfile.institutionId, institutionId),
  );
}

export async function loadParticipation(params: {
  exec?: Executor;
  sessionId: string;
  actor: Actor;
}): Promise<Participation> {
  const rows = await sessionContext(params.exec)
    .where(
      and(
        eq(sessionBooking.id, params.sessionId),
        onCampus(params.actor.institutionId),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) throw new SessionError("That session does not exist.");

  if (row.studentUserId === row.tutorUserId) {
    throw new SessionError(
      "That session has the same person on both sides and cannot be settled.",
    );
  }

  const role = participantRole(row, params.actor);
  if (!role) throw new SessionError("That session is not yours.");

  return { ...row, role };
}

function participantRole(
  row: { studentProfileId: string; tutorProfileId: string },
  actor: Actor,
): "student" | "tutor" | null {
  if (row.studentProfileId === actor.studentProfileId) return "student";
  if (actor.tutorProfileId && row.tutorProfileId === actor.tutorProfileId) {
    return "tutor";
  }
  return null;
}

export async function lockSession(tx: Tx, sessionId: string): Promise<void> {
  await tx
    .select({ id: sessionBooking.id })
    .from(sessionBooking)
    .where(eq(sessionBooking.id, sessionId))
    .for("update")
    .limit(1);
}
