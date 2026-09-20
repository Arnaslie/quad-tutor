/**
 * Who may act on a session, and what the rest of the module needs to know
 * about it.
 *
 * Every mutation and every read in this module starts here. Two rules it
 * exists to make unavoidable:
 *
 *   - The caller is authorised against the session, not against an id they
 *     supplied. A session belongs to exactly two people; anyone else gets the
 *     same answer as a session that does not exist.
 *   - `institutionId` comes from the signed-in actor and is compared against
 *     the row, never accepted as an argument. A query that takes the tenant
 *     key from the client is a cross-campus leak waiting to happen.
 */

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
/** Anything you can run a query on: the pool or an open transaction. */
export type Executor = typeof db | Tx;

/** Both humans on a session are rows in `user`, so one of them needs an alias. */
export const tutorUser = alias(user, "tutor_user");

/** The session plus everything needed to settle it, with the caller's side. */
export type Participation = SessionContextRow & { role: "student" | "tutor" };

/** Everything `sessionContext` selects. No caller attached — the sweep and the
 *  dispute resolver act on sessions nobody is signed in for. */
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
  /**
   * Dispute evidence for a human, and nothing else. It must never be read by
   * `reliability/standing.ts`, reach `matching/score.ts`, or gate or rank
   * anything on either side — reliability is timestamped facts only, and a
   * free-text column is the usual way that invariant quietly dies. The
   * `*DeniedAt` timestamps beside it are facts; settle and rank off those.
   */
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

  /** The wedge, carried on every session row: which course, under whom. */
  courseId: string;
  courseCode: string | null;
  courseTitle: string;
  section: string | null;
  professorName: string | null;
  termName: string;
};

/**
 * The join every session query in this module needs: booking to package to
 * both humans. Written once, because getting it wrong is how the wrong person
 * sees someone else's tutoring.
 */
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
    // Left, both of them, and the current-code predicate lives in the join
    // rather than the WHERE: a course between renumberings, or an offering
    // with no professor recorded yet, must not make a booked session vanish
    // from the student's list.
    .leftJoin(
      courseCodeAlias,
      and(
        eq(courseCodeAlias.courseId, course.id),
        isNull(courseCodeAlias.validToTermId),
      ),
    )
    .leftJoin(professor, eq(professor.id, courseOffering.professorId));
}

/** Both sides of a package are campus-scoped; both are checked. */
export function onCampus(institutionId: string) {
  return and(
    eq(studentProfile.institutionId, institutionId),
    eq(tutorProfile.institutionId, institutionId),
  );
}

/**
 * Load a session the actor is actually part of, or throw. `role` is derived
 * from which side of the row the actor sits on — a user who is both a tutor
 * and a student (routine on a peer campus) gets the right one per session.
 */
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

  // Unreachable by construction — `purchasePackage` refuses a self-package and
  // the matching module cannot produce one. Asserted anyway because the
  // failure mode is silent: `participantRole` resolves one role per person, so
  // a session with the same human on both sides would be answerable from
  // neither side, attendance would never settle, and the money would never
  // recognise. A thrown error is found in a day; that is found in a quarter.
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

/**
 * Locks the booking row for the rest of the transaction. Confirmations,
 * cancellations and the auto-release sweep all race each other — the sweep can
 * fire in the same millisecond as a confirmation — so every state change takes
 * this first and re-reads what it locked.
 */
export async function lockSession(tx: Tx, sessionId: string): Promise<void> {
  await tx
    .select({ id: sessionBooking.id })
    .from(sessionBooking)
    .where(eq(sessionBooking.id, sessionId))
    .for("update")
    .limit(1);
}
