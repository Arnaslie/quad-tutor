import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  ledgerEntry,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import { feeChargedThisTermMinor } from "@/server/modules/billing/ledger";
import { TERM_FEE_CAP_MINOR } from "@/server/modules/billing/pricing";
import { currentTerm } from "@/server/modules/catalog/courses";
import type { TutorActor } from "@/server/modules/identity/actor";

export type TutorEarnings = {
  earnedMinor: number;

  owedMinor: number;
  /** Always 0 in this draft — see TODO(stripe) below. */
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

export async function earningsForTutor(tutor: TutorActor): Promise<TutorEarnings> {
  const rows = await db
    .select({
      earnedMinor: sql<number>`coalesce(sum(${ledgerEntry.amountMinor}), 0)::int`,

      sessionsDelivered: sql<number>`count(${ledgerEntry.sessionId})::int`,

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
        eq(ledgerEntry.type, "tutor_accrued"),
      ),
    );

  const totals = rows.at(0);
  if (!totals) return NO_EARNINGS;

  // TODO(stripe): when a payout run exists, this is the one line that changes

  const transferredMinor = 0;

  return {
    earnedMinor: totals.earnedMinor,
    owedMinor: totals.earnedMinor - transferredMinor,
    transferredMinor,
    currency: totals.currency,
    sessionsDelivered: totals.sessionsDelivered,
  };
}

export type FeeCapProgress = { chargedMinor: number; capMinor: number; termName: string };

export async function feeCapProgressForTutor(tutor: TutorActor): Promise<FeeCapProgress | null> {
  const current = await currentTerm(tutor.institutionId);
  if (!current) return null;

  const chargedMinor = await feeChargedThisTermMinor(db, {
    tutorProfileId: tutor.tutorProfileId,
    termId: current.id,
    institutionId: tutor.institutionId,
  });

  return { chargedMinor, capMinor: TERM_FEE_CAP_MINOR, termName: current.name };
}
