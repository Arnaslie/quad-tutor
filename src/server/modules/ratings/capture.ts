import { and, isNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { sessionRating } from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";

import { rateInput } from "./input";
import { studentRating } from "./reads";
import { closesAt, RatingError, ratingEarnedAt } from "./window";

export async function rateSession(params: {
  actor: Actor;
  sessionId: string;
  stars: number;
  note: string | null;
}): Promise<void> {
  const parsed = rateInput.safeParse(params);
  if (!parsed.success) throw new RatingError(parsed.error.issues[0].message);
  const { sessionId, stars, note } = parsed.data;
  const { actor } = params;

  const row = await studentRating(actor, sessionId);
  if (!row) throw new RatingError("That session is not yours to rate.");
  if (row.status !== "completed") throw new RatingError("Only a session that took place can be rated.");
  if (!row.earnedAt) throw new RatingError("This session has not settled yet.");
  if (row.removedAt) throw new RatingError("This rating was removed and can't be changed.");
  if (!row.open) throw new RatingError("Ratings for this session have closed.");

  const saved = await saveRating({
    institutionId: actor.institutionId,
    sessionId,
    tutorCourseId: row.tutorCourseId,
    studentProfileId: actor.studentProfileId,
    stars,
    note,
  });
  if (saved.length === 0) throw new RatingError("This rating is closed or was removed and can't be changed.");
}

export function saveRating(values: typeof sessionRating.$inferInsert) {
  return db
    .insert(sessionRating)
    .values(values)
    .onConflictDoUpdate({
      target: sessionRating.sessionId,
      set: { stars: values.stars, note: values.note, updatedAt: sql`now()` },
      setWhere: and(
        isNull(sessionRating.removedAt),
        isNull(sessionRating.releasedAt),
        sql`${closesAt(ratingEarnedAt)} > now()`,
      ),
    })
    .returning({ id: sessionRating.id });
}
