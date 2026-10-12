import { and, eq, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { moneyDiscrepancy } from "@/server/db/schema";

import type { Refund } from "./stripe";

export type Ids = { engagementId: string; institutionId: string };

export async function recordDiscrepancy(
  ids: Ids,
  values: Omit<typeof moneyDiscrepancy.$inferInsert, "institutionId" | "engagementId">,
): Promise<string | null> {
  const [created] = await db
    .insert(moneyDiscrepancy)
    .values({ ...values, institutionId: ids.institutionId, engagementId: ids.engagementId })
    .onConflictDoNothing()
    .returning({ id: moneyDiscrepancy.id });
  if (created || !values.stripeReference) return created?.id ?? null;

  const [existing] = await db
    .select({ id: moneyDiscrepancy.id })
    .from(moneyDiscrepancy)
    .where(
      and(
        eq(moneyDiscrepancy.institutionId, ids.institutionId),
        eq(moneyDiscrepancy.kind, values.kind),
        eq(moneyDiscrepancy.stripeReference, values.stripeReference),
      ),
    );
  return existing?.id ?? null;
}

export const MANUAL_REFUND_PREFIX = "manual:";

/**
 * A refund Stripe could not deliver is never re-issued by code: the card that bounced it would bounce
 * the next one too. Keyed on the PaymentIntent; a repeat on it fills in the ledger row if the first had none.
 * One PaymentIntent never carries two refund rows: it is one engagement's purchase, with one refund.
 */
export async function recordRefundFailure(
  ids: Ids,
  failed: {
    paymentIntentId: string;
    refund: Refund | null;
    amountMinor: number | null;
    currency: string;
    ledgerEntryId?: string;
  },
): Promise<void> {
  console.error(
    `[refund] ${failed.refund?.id ?? "create"} on ${failed.paymentIntentId} for ${ids.engagementId} failed (${failed.refund?.failureReason ?? "refused at create"}); flagged for ops`,
  );
  await db
    .insert(moneyDiscrepancy)
    .values({
      ...ids,
      kind: "refund_failed",
      stripeReference: failed.paymentIntentId,
      ledgerEntryId: failed.ledgerEntryId,
      ledgerAmountMinor: failed.amountMinor,
      stripeAmountMinor: 0,
      currency: failed.currency,
    })
    .onConflictDoUpdate({
      target: [moneyDiscrepancy.kind, moneyDiscrepancy.stripeReference],
      targetWhere: sql`${moneyDiscrepancy.stripeReference} is not null`,
      set: { ledgerEntryId: sql`coalesce(${moneyDiscrepancy.ledgerEntryId}, excluded.ledger_entry_id)` },
    });
}

const blocker = alias(moneyDiscrepancy, "refund_blocker");

/** Any discrepancy naming a ledger row stops that row for good; resolving one never re-arms it. */
export const ledgerRowBlocker = (ledgerEntryId: AnyColumn, institutionId: AnyColumn | string) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(and(eq(blocker.ledgerEntryId, ledgerEntryId), eq(blocker.institutionId, institutionId)));

/** A failed refund of a payment that was never booked stops that PaymentIntent's refunds for good. */
export const paymentRefundBlocker = (paymentIntentId: AnyColumn | string, institutionId: AnyColumn | string) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(
      and(
        eq(blocker.kind, "refund_failed"),
        eq(blocker.stripeReference, paymentIntentId),
        eq(blocker.institutionId, institutionId),
      ),
    );
