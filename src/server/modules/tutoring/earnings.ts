/**
 * What a tutor has actually earned, and what is still owed to them.
 *
 * Derived from the ledger and only from the ledger. `tutor_payout` rows are
 * written when a session is delivered and never before, so everything here is
 * money already earned rather than money that might arrive. A projection of
 * what is booked would be a forecast wearing the same font as a fact, and the
 * booked session that gets cancelled would make a liar of the screen. There is
 * deliberately no "pending" figure for that reason.
 *
 * Earned and owed are returned separately even though they are equal today,
 * because `ledger.ts` defines them differently:
 *
 *     owed to tutor = sum(tutor_payout) - sum(actually paid out)
 *
 * Nothing has ever been paid out — there is no transfer record and no payout
 * run — so `transferredMinor` is 0 and `owedMinor` equals `earnedMinor`. The
 * day that stops being true, a screen that had been showing `earnedMinor` and
 * calling it "owed" would silently start lying, and nobody would notice until
 * a tutor did. Keeping the two names apart now costs one field.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  ledgerEntry,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";

export type TutorEarnings = {
  /** Lifetime accrual from delivered sessions. Only ever goes up. */
  earnedMinor: number;
  /** Earned minus transferred: what the platform still holds for them. */
  owedMinor: number;
  /** Always 0 in this draft — see TODO(stripe) below. */
  transferredMinor: number;
  currency: string;
  /** Sessions that have actually been delivered. Not sessions booked. */
  sessionsDelivered: number;
};

export const NO_EARNINGS: TutorEarnings = {
  earnedMinor: 0,
  owedMinor: 0,
  transferredMinor: 0,
  currency: "usd",
  sessionsDelivered: 0,
};

export async function earningsForTutor(tutor: TutorActor): Promise<TutorEarnings> {
  const rows = await db
    .select({
      earnedMinor: sql<number>`coalesce(sum(${ledgerEntry.amountMinor}), 0)::int`,
      // Exactly one `tutor_payout` row per delivered session, so counting the
      // rows counts the sessions without a second join.
      sessionsDelivered: sql<number>`count(${ledgerEntry.sessionId})::int`,
      // Single-currency product; this is here so the display never has to
      // assume one, because the second campus is where that assumption breaks.
      currency: sql<string>`coalesce(max(${ledgerEntry.currency}), 'usd')`,
    })
    .from(ledgerEntry)
    .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(tutorProfile.id, tutor.tutorProfileId),
        eq(tutorProfile.institutionId, tutor.institutionId),
        eq(ledgerEntry.type, "tutor_payout"),
      ),
    );

  const totals = rows.at(0);
  if (!totals) return NO_EARNINGS;

  // TODO(stripe): when a payout run exists, this is the one line that changes
  // — sum whatever records a completed transfer, and `owedMinor` follows from
  // the subtraction below without any screen needing to be touched.
  const transferredMinor = 0;

  return {
    earnedMinor: totals.earnedMinor,
    owedMinor: totals.earnedMinor - transferredMinor,
    transferredMinor,
    currency: totals.currency,
    sessionsDelivered: totals.sessionsDelivered,
  };
}
