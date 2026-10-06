import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { courseOffering, engagement, sessionBooking, sessionRating, term } from "@/server/db/schema";

import { MIN_RATINGS, RELEASE_BATCH, TERM_END_MIN } from "./rules";
import { ratingReleased, ratingWindowClosed } from "./window";

export async function releaseRatings(institutionId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [{ locked }] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext(${`ratings-release:${institutionId}`})) as locked`,
    );
    if (!locked) return 0;

    const closed = tx.$with("closed").as(
      tx
        .select({
          id: sessionRating.id,
          tutorCourseId: sessionRating.tutorCourseId,
          pending: sql<number>`count(*) over (partition by ${sessionRating.tutorCourseId})`.as("pending"),
          termsEnded: sql<boolean>`bool_and(${term.endsOn} < current_date) over (partition by ${sessionRating.tutorCourseId})`.as(
            "terms_ended",
          ),
        })
        .from(sessionRating)
        .innerJoin(
          sessionBooking,
          and(eq(sessionBooking.id, sessionRating.sessionId), eq(sessionBooking.institutionId, institutionId)),
        )
        .innerJoin(engagement, and(eq(engagement.id, sessionBooking.engagementId), eq(engagement.institutionId, institutionId)))
        .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
        .innerJoin(term, and(eq(term.id, courseOffering.termId), eq(term.institutionId, institutionId)))
        .where(
          and(
            eq(sessionRating.institutionId, institutionId),
            isNull(sessionRating.removedAt),
            isNull(sessionRating.releasedAt),
            ratingWindowClosed,
          ),
        ),
    );
    const primed = tx.$with("primed").as(
      tx
        .selectDistinct({ primedCourseId: sessionRating.tutorCourseId })
        .from(sessionRating)
        .where(and(eq(sessionRating.institutionId, institutionId), ratingReleased)),
    );
    const due = tx
      .with(closed, primed)
      .select({ id: closed.id })
      .from(closed)
      .leftJoin(primed, eq(primed.primedCourseId, closed.tutorCourseId))
      .where(
        sql`${closed.pending} >= case when ${primed.primedCourseId} is null then ${MIN_RATINGS}::int else ${RELEASE_BATCH}::int end
          or (${closed.termsEnded} and ${closed.pending} >= ${TERM_END_MIN}::int)`,
      );

    const released = await tx
      .update(sessionRating)
      .set({ releasedAt: sql`now()` })
      .where(and(inArray(sessionRating.id, due), isNull(sessionRating.releasedAt)))
      .returning({ id: sessionRating.id });
    return released.length;
  });
}
