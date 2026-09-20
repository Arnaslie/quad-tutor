/**
 * The ledger. Append-only; nothing in here is ever updated or deleted.
 *
 * The invariant it exists to hold: **a package purchased up front is deferred
 * revenue, not income.** Cash arriving is not a sale. Recognised revenue
 * derives from sessions actually delivered, and tutor pay is a liability held
 * until the session it belongs to has happened.
 *
 *   deferred = sum(package_purchase) - sum(session_earned) - sum(refund)
 *   recognised = sum(session_earned)
 *   owed to tutor = sum(tutor_payout) - sum(actually paid out)
 *   margin = sum(session_earned) - sum(tutor_payout)
 *
 * `platform_fee` is deliberately not written per session: it is exactly
 * `session_earned - tutor_payout`, and storing a third derivable row invites
 * the three to disagree. It is reserved for Stripe application fees, which are
 * a real separate movement.
 *
 * Amounts are signed, positive meaning "this much moved into this bucket", and
 * always integer minor units.
 */

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

/** Derived, never stored. The rows are the truth. */
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

/** Has this engagement's first-session guarantee already been absorbed? */
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
