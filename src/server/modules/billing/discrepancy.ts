import { and, eq, isNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { moneyDiscrepancy } from "@/server/db/schema";

import type { Refund } from "./stripe";

export type Ids = { engagementId: string; institutionId: string };

/**
 * One flag per kind and Stripe object. A repeat leaves an open flag alone; on a resolved one it reopens the flag
 * only when the gap between the amounts moved since, so a second divergence on the same object is news, and the
 * same one seen again is not, even when a refund or transfer since moved both sides by the same amount.
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
      // The reconciliation resolves an orphaned account's flag only once a tutor holds it, so flagged again it is news.
      setWhere: sql`${moneyDiscrepancy.institutionId} = excluded.institution_id
        and ${moneyDiscrepancy.resolvedAt} is not null
        and (
          ${moneyDiscrepancy.ledgerAmountMinor} - ${moneyDiscrepancy.stripeAmountMinor}
            is distinct from excluded.ledger_amount_minor - excluded.stripe_amount_minor
          or (${moneyDiscrepancy.kind} = 'orphaned_account' and ${moneyDiscrepancy.resolvedByUserId} is null)
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
 * A row failing, or a refund the flag has not recorded failing, on a flag ops already resolved reopens it at that
 * amount: the money it names is news. The reconciliation replays every failed refund on the PaymentIntent each
 * day, so which refunds already failed is told apart by their ids, never by an amount.
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
      failedRefundIds: failed.refund ? [failed.refund.id] : [],
    })
    .onConflictDoUpdate({
      target: [moneyDiscrepancy.kind, moneyDiscrepancy.stripeReference],
      targetWhere: sql`${moneyDiscrepancy.stripeReference} is not null`,
      set: {
        ledgerEntryId: sql`coalesce(${moneyDiscrepancy.ledgerEntryId}, excluded.ledger_entry_id)`,
        ledgerAmountMinor: onNews(sql`excluded.ledger_amount_minor`, moneyDiscrepancy.ledgerAmountMinor),
        detectedAt: onNews(sql`now()`, moneyDiscrepancy.detectedAt),
        resolvedAt: onNews(sql`null`, moneyDiscrepancy.resolvedAt),
        resolvedByUserId: onNews(sql`null`, moneyDiscrepancy.resolvedByUserId),
        resolutionNote: onNews(sql`null`, moneyDiscrepancy.resolutionNote),
        failedRefundIds: sql`case when ${moneyDiscrepancy.failedRefundIds} @> excluded.failed_refund_ids
          then ${moneyDiscrepancy.failedRefundIds} else ${moneyDiscrepancy.failedRefundIds} || excluded.failed_refund_ids end`,
      },
      setWhere: sql`${moneyDiscrepancy.institutionId} = excluded.institution_id`,
    });
}

const onNews = (value: SQL, column: AnyColumn) =>
  sql`case when (${moneyDiscrepancy.ledgerEntryId} is null and excluded.ledger_entry_id is not null)
    or (${moneyDiscrepancy.resolvedAt} is not null and not ${moneyDiscrepancy.failedRefundIds} @> excluded.failed_refund_ids)
    then ${value} else ${column} end`;

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
