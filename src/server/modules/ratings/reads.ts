import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  engagement,
  ledgerEntry,
  messageReport,
  sessionBooking,
  sessionRating,
  tutorCourse,
} from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { courseLabel } from "@/server/modules/messaging/threads";

import { MIN_RATINGS, publicRating, type PublicRating } from "./rules";
import { closesAt, earnedAt, ratingReleased } from "./window";

export type CardRatings = {
  courseRating: PublicRating | null;
  overallRating: PublicRating | null;
};

export async function cardRatings(
  institutionId: string,
  tutorCourseIds: string[],
): Promise<Map<string, CardRatings>> {
  const result = new Map<string, CardRatings>();
  if (tutorCourseIds.length === 0) return result;

  const claims = await db
    .select({ id: tutorCourse.id, tutorProfileId: tutorCourse.tutorProfileId })
    .from(tutorCourse)
    .where(and(eq(tutorCourse.institutionId, institutionId), inArray(tutorCourse.id, tutorCourseIds)));
  const tutors = [...new Set(claims.map((claim) => claim.tutorProfileId))];
  if (tutors.length === 0) return result;

  const [perCourse, delivered] = await Promise.all([
    db
      .select({
        tutorProfileId: tutorCourse.tutorProfileId,
        tutorCourseId: sessionRating.tutorCourseId,
        sum: sql<number>`sum(${sessionRating.stars})::int`,
        count: sql<number>`count(*)::int`,
      })
      .from(sessionRating)
      .innerJoin(tutorCourse, eq(tutorCourse.id, sessionRating.tutorCourseId))
      .where(
        and(
          eq(sessionRating.institutionId, institutionId),
          isNull(sessionRating.removedAt),
          inArray(tutorCourse.tutorProfileId, tutors),
          ratingReleased,
        ),
      )
      .groupBy(tutorCourse.tutorProfileId, sessionRating.tutorCourseId),
    db
      .select({ tutorProfileId: tutorCourse.tutorProfileId, sessions: sql<number>`count(*)::int` })
      .from(ledgerEntry)
      .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
      .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
      .where(
        and(
          eq(ledgerEntry.institutionId, institutionId),
          eq(ledgerEntry.type, "session_earned"),
          inArray(tutorCourse.tutorProfileId, tutors),
        ),
      )
      .groupBy(tutorCourse.tutorProfileId),
  ]);

  const sessions = new Map(delivered.map((row) => [row.tutorProfileId, row.sessions]));
  const overall = new Map<string, { sum: number; count: number }>();
  for (const row of perCourse) {
    if (row.count < MIN_RATINGS) continue;
    const total = overall.get(row.tutorProfileId) ?? { sum: 0, count: 0 };
    overall.set(row.tutorProfileId, { sum: total.sum + row.sum, count: total.count + row.count });
  }
  const byCourse = new Map(perCourse.map((row) => [row.tutorCourseId, row]));

  for (const claim of claims) {
    const delivered = sessions.get(claim.tutorProfileId) ?? 0;
    const own = byCourse.get(claim.id);
    const all = overall.get(claim.tutorProfileId);
    result.set(claim.id, {
      courseRating: publicRating(own?.sum ?? 0, own?.count ?? 0, delivered),
      overallRating: publicRating(all?.sum ?? 0, all?.count ?? 0, delivered),
    });
  }
  return result;
}

export type TutorNote = {
  ratingId: string;
  note: string;
  courseLabel: string;
  reported: boolean;
};

export async function notesForTutor(actor: TutorActor): Promise<TutorNote[]> {
  const rows = await db
    .select({
      ratingId: sessionRating.id,
      note: sessionRating.note,
      courseLabel,
      reported: sql<boolean>`exists (
        select 1 from ${messageReport}
        where ${messageReport.sessionRatingId} = ${sessionRating.id}
          and ${messageReport.institutionId} = ${sessionRating.institutionId}
          and ${messageReport.reviewedAt} is null
      )`,
    })
    .from(sessionRating)
    .innerJoin(
      tutorCourse,
      and(
        eq(tutorCourse.id, sessionRating.tutorCourseId),
        eq(tutorCourse.institutionId, sessionRating.institutionId),
      ),
    )
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        eq(sessionRating.institutionId, actor.institutionId),
        eq(tutorCourse.tutorProfileId, actor.tutorProfileId),
        isNull(sessionRating.removedAt),
        isNotNull(sessionRating.note),
        ratingReleased,
      ),
    )
    .orderBy(desc(sessionRating.releasedAt), sessionRating.id)
    .limit(100);

  return rows.map((row) => ({ ...row, note: row.note ?? "" }));
}

export function studentRating(actor: Actor, sessionId: string) {
  const earned = earnedAt(sessionBooking.id, sessionBooking.institutionId);
  return db
    .select({
      status: sessionBooking.status,
      tutorCourseId: engagement.tutorCourseId,
      earnedAt: earned,
      closesAt: closesAt(earned),
      open: sql<boolean>`coalesce(${closesAt(earned)} > now(), false)`,
      stars: sessionRating.stars,
      note: sessionRating.note,
      removedAt: sessionRating.removedAt,
    })
    .from(sessionBooking)
    .innerJoin(engagement, eq(engagement.id, sessionBooking.engagementId))
    .leftJoin(
      sessionRating,
      and(
        eq(sessionRating.sessionId, sessionBooking.id),
        eq(sessionRating.institutionId, sessionBooking.institutionId),
      ),
    )
    .where(
      and(
        eq(sessionBooking.id, sessionId),
        eq(sessionBooking.institutionId, actor.institutionId),
        eq(engagement.studentProfileId, actor.studentProfileId),
      ),
    )
    .limit(1)
    .then((rows) => rows.at(0) ?? null);
}

export type SessionRatingState = {
  open: boolean;
  closesAt: Date;
  rating: { stars: number; note: string | null } | null;
};

export async function sessionRatingState(
  actor: Actor,
  sessionId: string,
): Promise<SessionRatingState | null> {
  const row = await studentRating(actor, sessionId);
  if (!row || row.status !== "completed" || !row.closesAt) return null;

  const removed = row.removedAt !== null;
  return {
    open: row.open && !removed,
    closesAt: row.closesAt,
    rating: row.stars !== null && !removed ? { stars: row.stars, note: row.note } : null,
  };
}
