import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  ledgerEntry,
  ledgerEntryType,
  tutorCourse,
} from "@/server/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function feeChargedThisTermMinor(
  exec: typeof db | Tx,
  scope: { tutorProfileId: string; termId: string; institutionId: string },
): Promise<number> {
  const rows = await exec
    .select({ total: sql<number>`coalesce(sum(${ledgerEntry.amountMinor}), 0)::int` })
    .from(ledgerEntry)
    .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .where(
      and(
        eq(ledgerEntry.type, "platform_fee"),
        eq(ledgerEntry.institutionId, scope.institutionId),
        eq(tutorCourse.tutorProfileId, scope.tutorProfileId),
        eq(courseOffering.termId, scope.termId),
      ),
    );

  return rows.at(0)?.total ?? 0;
}

export type LedgerWrite = {
  engagementId: string;
  institutionId: string;
  sessionId?: string | null;
  type: (typeof ledgerEntry.$inferInsert)["type"];
  amountMinor: number;
  currency?: string;
  stripeReference?: string | null;
};

export async function record(tx: Tx, entries: LedgerWrite[]): Promise<void> {
  if (entries.length === 0) return;
  await tx.insert(ledgerEntry).values(entries);
}

export type EngagementBalance = {
  paidMinor: number;
  recognisedMinor: number;
  deferredMinor: number;
  tutorOwedMinor: number;
  refundedMinor: number;
};

export async function balanceFor(engagementId: string): Promise<EngagementBalance> {
  const totals = await db
    .select({
      type: ledgerEntry.type,
      total: sql<number>`sum(${ledgerEntry.amountMinor})::int`,
    })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.engagementId, engagementId))
    .groupBy(ledgerEntry.type);

  const by = (type: (typeof ledgerEntryType.enumValues)[number]) =>
    totals.find((row) => row.type === type)?.total ?? 0;

  const paidMinor = by("package_purchase");
  const recognisedMinor = by("session_earned");
  const refundedMinor = by("refund");

  return {
    paidMinor,
    recognisedMinor,
    refundedMinor,
    deferredMinor: paidMinor - recognisedMinor - refundedMinor,
    tutorOwedMinor: by("tutor_accrued"),
  };
}
