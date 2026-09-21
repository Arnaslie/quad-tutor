import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { ledgerEntry } from "@/server/db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LedgerWrite = {
  engagementId: string;
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

  const by = (type: string) =>
    totals.find((row) => row.type === type)?.total ?? 0;

  const paidMinor = by("package_purchase");
  const recognisedMinor = by("session_earned");
  const refundedMinor = by("refund");

  return {
    paidMinor,
    recognisedMinor,
    refundedMinor,
    deferredMinor: paidMinor - recognisedMinor - refundedMinor,
    tutorOwedMinor: by("tutor_payout"),
  };
}

export async function guaranteeAbsorbed(engagementId: string): Promise<boolean> {
  const rows = await db
    .select({ id: ledgerEntry.id })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.engagementId, engagementId),
        eq(ledgerEntry.type, "guarantee_absorbed"),
      ),
    )
    .limit(1);

  return rows.at(0) !== undefined;
}
