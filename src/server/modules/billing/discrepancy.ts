import { and, eq, isNull, like, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { moneyDiscrepancy } from "@/server/db/schema";

import type { Refund } from "./stripe";

export type Ids = { engagementId: string; institutionId: string };

/** An orphaned Connect account belongs to no engagement, so its flag pauses nothing. */
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
 * the next one too. A failure of one of our refund rows is keyed on that row, since a PaymentIntent can carry
 * many; a refund made in the Dashboard has no row and is keyed on its PaymentIntent.
 * A refund the flag has not recorded failing, on a flag ops already resolved, reopens it at that amount: the money
 * it names is news. The reconciliation replays every failed refund on the PaymentIntent each day, so which refunds
 * already failed is told apart by their ids, never by an amount. Reopening a PaymentIntent's flag keeps ops' last note.
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
    `[refund] ${failed.refund?.id ?? "create"} on ${failed.paymentIntentId} for ${failed.ledgerEntryId ?? ids.engagementId} failed (${failed.refund?.failureReason ?? "refused at create"}); flagged for ops`,
  );
  await db
    .insert(moneyDiscrepancy)
    .values({
      engagementId: ids.engagementId,
      institutionId: ids.institutionId,
      kind: "refund_failed",
      stripeReference: failed.ledgerEntryId ?? failed.paymentIntentId,
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
        ledgerAmountMinor: onNews(sql`excluded.ledger_amount_minor`, moneyDiscrepancy.ledgerAmountMinor),
        detectedAt: onNews(sql`now()`, moneyDiscrepancy.detectedAt),
        resolvedAt: onNews(sql`null`, moneyDiscrepancy.resolvedAt),
        resolvedByUserId: onNews(sql`null`, moneyDiscrepancy.resolvedByUserId),
        resolutionNote: onNews(sql`case when excluded.ledger_entry_id is null then ${moneyDiscrepancy.resolutionNote} end`, moneyDiscrepancy.resolutionNote),
        failedRefundIds: sql`case when ${moneyDiscrepancy.failedRefundIds} @> excluded.failed_refund_ids
          then ${moneyDiscrepancy.failedRefundIds} else ${moneyDiscrepancy.failedRefundIds} || excluded.failed_refund_ids end`,
      },
      setWhere: sql`${moneyDiscrepancy.institutionId} = excluded.institution_id`,
    });
}

const onNews = (value: SQL, column: AnyColumn) =>
  sql`case when ${moneyDiscrepancy.resolvedAt} is not null and not ${moneyDiscrepancy.failedRefundIds} @> excluded.failed_refund_ids
    then ${value} else ${column} end`;

const blocker = alias(moneyDiscrepancy, "refund_blocker");

/** Any discrepancy naming a ledger row stops that row for good; resolving one never re-arms it. */
export const ledgerRowBlocker = (
  ledgerEntryId: AnyColumn,
  institutionId: AnyColumn | string,
  { kind }: { kind?: (typeof moneyDiscrepancy.$inferSelect)["kind"] } = {},
) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(
      and(
        eq(blocker.ledgerEntryId, ledgerEntryId),
        eq(blocker.institutionId, institutionId),
        kind ? eq(blocker.kind, kind) : undefined,
      ),
    );

/**
 * A refund of the purchase that failed with no ledger row of ours (one made in the Dashboard) holds every unsent
 * refund of the engagement until ops resolves it, so none is sent to a card that just bounced one.
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

/**
 * A live refund made in the Dashboard stops the first refund row that finds it. The engagement's other unsent
 * refunds wait behind it until ops books it onto that row, then go out without it counting as foreign again.
 */
export const unbookedDashboardRefund = (ledgerEntryId: AnyColumn, engagementId: AnyColumn, institutionId: AnyColumn) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(
      and(
        eq(blocker.kind, "ledger_vs_stripe_charge"),
        like(blocker.stripeReference, "re\\_%"),
        eq(blocker.engagementId, engagementId),
        eq(blocker.institutionId, institutionId),
        ne(blocker.ledgerEntryId, ledgerEntryId),
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
