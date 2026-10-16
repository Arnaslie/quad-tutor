import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { escapeLike } from "@/server/db/like";
import {
  engagement,
  ledgerEntry,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import { FORFEITED_PREFIX, MANUAL_PREFIX } from "@/server/modules/billing/discrepancy";
import { FIXTURE_TRANSFER_PREFIX } from "@/server/modules/billing/fixtures";
import { feesToDate } from "@/server/modules/billing/ledger";
import type { TutorActor } from "@/server/modules/identity/actor";

export type TutorEarnings = {
  earnedMinor: number;

  owedMinor: number;
  transferredMinor: number;
  currency: string;

  sessionsDelivered: number;
};

export const NO_EARNINGS: TutorEarnings = {
  earnedMinor: 0,
  owedMinor: 0,
  transferredMinor: 0,
  currency: "usd",
  sessionsDelivered: 0,
};

/**
 * Transferred counts what Stripe confirmed (a stamped `tr_…`), ops paid by hand (`manual:…`) or a persona's
 * history recorded (`fixture_tr_…`), less what ops reversed. Pay ops wrote off (`forfeited:…`) is neither
 * transferred nor owed.
 */
export async function earningsForTutor(tutor: TutorActor): Promise<TutorEarnings> {
  const accrued = sql`${ledgerEntry.type} = 'tutor_accrued'`;
  const transfer = (prefix: string) =>
    sql`${ledgerEntry.type} = 'tutor_transfer' and ${ledgerEntry.stripeReference} like ${`${prefix}%`}`;
  const rows = await db
    .select({
      earnedMinor: sql<number>`coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${accrued}), 0)::bigint`.mapWith(Number),
      transferredMinor: sql<number>`(
        coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${transfer("tr\\_")} or ${transfer(MANUAL_PREFIX)} or ${transfer(escapeLike(FIXTURE_TRANSFER_PREFIX))}), 0)
        - coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${ledgerEntry.type} = 'transfer_reversal'), 0)
      )::bigint`.mapWith(Number),
      forfeitedMinor: sql<number>`coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${transfer(FORFEITED_PREFIX)}), 0)::bigint`.mapWith(Number),
      sessionsDelivered: sql<number>`count(${ledgerEntry.sessionId}) filter (where ${accrued})::int`,
      currency: sql<string>`coalesce(max(${ledgerEntry.currency}) filter (where ${accrued}), 'usd')`,
    })
    .from(ledgerEntry)
    .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(tutorProfile.id, tutor.tutorProfileId),
        eq(tutorProfile.institutionId, tutor.institutionId),
        inArray(ledgerEntry.type, ["tutor_accrued", "tutor_transfer", "transfer_reversal"]),
      ),
    );

  const totals = rows.at(0);
  if (!totals) return NO_EARNINGS;

  return {
    earnedMinor: totals.earnedMinor,
    owedMinor: totals.earnedMinor - totals.transferredMinor - totals.forfeitedMinor,
    transferredMinor: totals.transferredMinor,
    currency: totals.currency,
    sessionsDelivered: totals.sessionsDelivered,
  };
}

/** The tutor's own fee meter, for their own card. Never part of a student-facing shape. */
export async function feeToDateForTutor(tutor: TutorActor): Promise<number> {
  const fees = await feesToDate(db, tutor.institutionId, [tutor.tutorProfileId]);
  return fees.get(tutor.tutorProfileId) ?? 0;
}
