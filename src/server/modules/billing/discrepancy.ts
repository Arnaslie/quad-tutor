import { and, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { moneyDiscrepancy } from "@/server/db/schema";

import type { Refund } from "./stripe";

export type Ids = { engagementId: string; institutionId: string };

/**
 * One flag per kind and Stripe object. A repeat leaves an open flag alone; on a resolved one it reopens the flag
 * only when the amounts moved since, so a second divergence on the same object is news and the same one is not.
 * An orphaned Connect account belongs to no engagement, so its flag pauses nothing.
 */
export async function recordDiscrepancy(
  ids: { engagementId: string | null; institutionId: string },
  values: Omit<typeof moneyDiscrepancy.$inferInsert, "institutionId" | "engagementId">,
): Promise<string | null> {
  const [created] = await db
    .insert(moneyDiscrepancy)
    .values({ ...values, institutionId: ids.institutionId, engagementId: ids.engagementId })
    .onConflictDoUpdate({
      target: [moneyDiscrepancy.kind, moneyDiscrepancy.stripeReference],
      targetWhere: sql`${moneyDiscrepancy.stripeReference} is not null`,
      set: {
        ledgerAmountMinor: sql`excluded.ledger_amount_minor`,
        stripeAmountMinor: sql`excluded.stripe_amount_minor`,
        detectedAt: sql`now()`,
        resolvedAt: null,
        resolvedByUserId: null,
        resolutionNote: null,
      },
      setWhere: sql`${moneyDiscrepancy.resolvedAt} is not null and (
        ${moneyDiscrepancy.ledgerAmountMinor} is distinct from excluded.ledger_amount_minor
        or ${moneyDiscrepancy.stripeAmountMinor} is distinct from excluded.stripe_amount_minor
      )`,
    })
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

export const MANUAL_PREFIX = "manual:";
export const FORFEITED_PREFIX = "forfeited:";

/**
 * A refund Stripe could not deliver is never re-issued by code: the card that bounced it would bounce
 * the next one too. Keyed on the PaymentIntent; a repeat on it fills in the ledger row if the first had none.
 * One PaymentIntent never carries two refund rows: it is one engagement's purchase, with one refund.
 * A row failing on a flag ops already resolved reopens it at that row's amount: the money it names is new news.
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
      engagementId: ids.engagementId,
      institutionId: ids.institutionId,
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
      set: {
        ledgerEntryId: onNewRow(sql`excluded.ledger_entry_id`, moneyDiscrepancy.ledgerEntryId),
        ledgerAmountMinor: onNewRow(sql`excluded.ledger_amount_minor`, moneyDiscrepancy.ledgerAmountMinor),
        detectedAt: onNewRow(sql`now()`, moneyDiscrepancy.detectedAt),
        resolvedAt: onNewRow(sql`null`, moneyDiscrepancy.resolvedAt),
        resolvedByUserId: onNewRow(sql`null`, moneyDiscrepancy.resolvedByUserId),
        resolutionNote: onNewRow(sql`null`, moneyDiscrepancy.resolutionNote),
      },
    });
}

const onNewRow = (value: SQL, column: AnyColumn) =>
  sql`case when ${moneyDiscrepancy.ledgerEntryId} is null and excluded.ledger_entry_id is not null then ${value} else ${column} end`;

const blocker = alias(moneyDiscrepancy, "refund_blocker");

/** Any discrepancy naming a ledger row stops that row for good; resolving one never re-arms it. */
export const ledgerRowBlocker = (ledgerEntryId: AnyColumn, institutionId: AnyColumn | string) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(and(eq(blocker.ledgerEntryId, ledgerEntryId), eq(blocker.institutionId, institutionId)));

/**
 * A refund of the purchase that failed with no ledger row of ours (one made in the Dashboard) holds the
 * engagement's own refund until ops resolves it, so it is not sent to a card that just bounced one.
 */
export const failedDashboardRefund = (paymentIntentId: AnyColumn, institutionId: AnyColumn) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(
      and(
        eq(blocker.kind, "refund_failed"),
        eq(blocker.stripeReference, paymentIntentId),
        eq(blocker.institutionId, institutionId),
        isNull(blocker.ledgerEntryId),
        isNull(blocker.resolvedAt),
      ),
    );

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
