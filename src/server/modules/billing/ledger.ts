import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  ledgerEntry,
  ledgerEntryType,
  tutorCourse,
} from "@/server/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lifetime platform fees per tutor on one campus. A tutor with none is absent from the map. */
export async function feesToDate(
  exec: typeof db | Tx,
  institutionId: string,
  tutorProfileIds: readonly string[],
): Promise<Map<string, number>> {
  if (tutorProfileIds.length === 0) return new Map();
  const rows = await exec
    .select({
      tutorProfileId: tutorCourse.tutorProfileId,
      feeMinor: sql<number>`sum(${ledgerEntry.amountMinor})::bigint`.mapWith(Number),
    })
    .from(ledgerEntry)
    .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .where(
      and(
        eq(ledgerEntry.type, "platform_fee"),
        eq(ledgerEntry.institutionId, institutionId),
        inArray(tutorCourse.tutorProfileId, [...tutorProfileIds]),
      ),
    )
    .groupBy(tutorCourse.tutorProfileId);

  return new Map(rows.map((row) => [row.tutorProfileId, row.feeMinor]));
}

/** Paid less recognised less refunded: what a package can still give back. */
export function deferredMinor(engagementId: AnyColumn, institutionId: AnyColumn): SQL<number> {
  return sql<number>`(${db
    .select({
      deferred: sql`coalesce(sum(case ${ledgerEntry.type}
        when 'package_purchase' then ${ledgerEntry.amountMinor}
        when 'session_earned' then -${ledgerEntry.amountMinor}
        when 'refund' then -${ledgerEntry.amountMinor}
        else 0 end), 0)::int`,
    })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.institutionId, institutionId)))})`;
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
