import { and, eq, isNull, like, lt, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { ledgerEntry } from "@/server/db/schema";

import { openRefundFailure, recordRefundFailure } from "./discrepancy";
import { GatewayError, errorFacts, isLiveRefund, stripeGateway, type Refund } from "./stripe";

const HOUR_MS = 60 * 60 * 1000;
const IDEMPOTENCY_WINDOW_MS = 24 * HOUR_MS;
const RETRY_GRACE_MS = 5 * 60 * 1000;
const RETRY_LIMIT = 20;

type Ids = { engagementId: string; institutionId: string };

export type RefundOutcome = "refunded" | "refund_failed" | "skipped" | "foreign";

type RefundRow = Ids & {
  id: string;
  amountMinor: number;
  currency: string;
  occurredAt: Date;
  paymentIntentId: string;
};

/** Stripe keeps a failed response under its key for 24h, so a retry moves to a fresh key each hour. */
export function retryKey(base: string, since: Date): string {
  return `${base}:${Math.floor((Date.now() - since.getTime()) / HOUR_MS)}`;
}

const purchase = alias(ledgerEntry, "purchase");

/** Unstamped refund rows of engagements bought through Stripe; one bought before Stripe has no `pi_` and never appears. */
async function unstampedRefunds(where: SQL[], limit: number): Promise<RefundRow[]> {
  const rows = await db
    .select({
      id: ledgerEntry.id,
      engagementId: ledgerEntry.engagementId,
      institutionId: ledgerEntry.institutionId,
      amountMinor: ledgerEntry.amountMinor,
      currency: ledgerEntry.currency,
      occurredAt: ledgerEntry.occurredAt,
      paymentIntentId: purchase.stripeReference,
    })
    .from(ledgerEntry)
    .innerJoin(
      purchase,
      and(
        eq(purchase.engagementId, ledgerEntry.engagementId),
        eq(purchase.institutionId, ledgerEntry.institutionId),
        eq(purchase.type, "package_purchase"),
        like(purchase.stripeReference, "pi\\_%"),
      ),
    )
    .where(
      and(
        eq(ledgerEntry.type, "refund"),
        isNull(ledgerEntry.stripeReference),
        notExists(openRefundFailure(ledgerEntry.engagementId)),
        ...where,
      ),
    )
    .orderBy(sql`random()`)
    .limit(limit);
  return rows.map((row) => ({ ...row, paymentIntentId: row.paymentIntentId! }));
}

async function stamp(row: Ids & { id: string }, refundId: string): Promise<void> {
  await db
    .update(ledgerEntry)
    .set({ stripeReference: refundId })
    .where(
      and(
        eq(ledgerEntry.id, row.id),
        eq(ledgerEntry.institutionId, row.institutionId),
        eq(ledgerEntry.type, "refund"),
        isNull(ledgerEntry.stripeReference),
      ),
    );
}

async function settle(row: Omit<RefundRow, "occurredAt">, refund: Refund): Promise<RefundOutcome> {
  await stamp(row, refund.id);
  if (isLiveRefund(refund)) return "refunded";
  await recordRefundFailure(row, { refund, paymentIntentId: row.paymentIntentId, amountMinor: row.amountMinor, currency: row.currency });
  return "refund_failed";
}

async function issue(row: RefundRow, retry: boolean): Promise<RefundOutcome> {
  const gateway = stripeGateway();
  let refund: Refund | undefined;
  if (retry || Date.now() - row.occurredAt.getTime() > IDEMPOTENCY_WINDOW_MS) {
    const mine = (await gateway.listRefunds(row.paymentIntentId)).filter((r) => r.ledgerEntryId === row.id);
    refund = mine.find(isLiveRefund) ?? mine.at(0);
  }
  if (!refund) {
    const key = `refund:${row.id}`;
    try {
      refund = await gateway.refund({
        paymentIntentId: row.paymentIntentId,
        engagementId: row.engagementId,
        institutionId: row.institutionId,
        amountMinor: row.amountMinor,
        ledgerEntryId: row.id,
        idempotencyKey: retry ? retryKey(key, row.occurredAt) : key,
      });
    } catch (error) {
      if (!(error instanceof GatewayError && error.refused)) throw error;
      await recordRefundFailure(row, { refund: null, paymentIntentId: row.paymentIntentId, amountMinor: row.amountMinor, currency: row.currency });
      return "refund_failed";
    }
  }
  return settle(row, refund);
}

/** After `closeWithRefund` commits: send its refund row to Stripe and stamp the `re_` on it. */
export async function refundThroughStripe(ids: Ids): Promise<RefundOutcome> {
  const [row] = await unstampedRefunds(
    [eq(ledgerEntry.engagementId, ids.engagementId), eq(ledgerEntry.institutionId, ids.institutionId)],
    1,
  );
  return row ? issue(row, false) : "skipped";
}

/** Rows whose after-commit call died. The grace keeps the sweep off a call still in flight. */
export async function retryUnstampedRefunds(
  institutionId: string,
  deadline: number,
): Promise<{ settled: number; failed: number }> {
  const rows = await unstampedRefunds(
    [eq(ledgerEntry.institutionId, institutionId), lt(ledgerEntry.occurredAt, new Date(Date.now() - RETRY_GRACE_MS))],
    RETRY_LIMIT,
  );
  let settled = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && Date.now() > deadline) break;
    try {
      await issue(row, true);
      settled += 1;
    } catch (error) {
      failed += 1;
      console.error(`[refund] retry failed for ${row.id}`, errorFacts(error));
    }
  }
  return { settled, failed };
}

async function reconcile(refund: Refund): Promise<RefundOutcome> {
  const { engagementId, institutionId, paymentIntentId } = refund;
  if (!engagementId || !institutionId || !paymentIntentId) return "foreign";
  const ids = { engagementId, institutionId };

  if (refund.ledgerEntryId) {
    const [row] = await db
      .select({ id: ledgerEntry.id, amountMinor: ledgerEntry.amountMinor, currency: ledgerEntry.currency })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.id, refund.ledgerEntryId),
          eq(ledgerEntry.engagementId, engagementId),
          eq(ledgerEntry.institutionId, institutionId),
          eq(ledgerEntry.type, "refund"),
        ),
      );
    return row ? settle({ ...ids, ...row, paymentIntentId }, refund) : "foreign";
  }
  if (isLiveRefund(refund)) return "skipped";
  await recordRefundFailure(ids, { refund, paymentIntentId, amountMinor: refund.amountMinor, currency: refund.currency });
  return "refund_failed";
}

export const REFUND_EVENTS = new Set(["charge.refunded", "refund.updated", "refund.failed", "charge.refund.updated"]);

/** Re-reads the refunds from Stripe, so a stale or repeated event only ever re-applies the current state. */
export async function handleRefundEvent(
  type: string,
  objectId: string,
): Promise<{ outcome: RefundOutcome; institutionId: string | null }> {
  const gateway = stripeGateway();
  const refunds = type === "charge.refunded" ? await gateway.chargeRefunds(objectId) : [await gateway.retrieveRefund(objectId)];
  const outcomes: RefundOutcome[] = [];
  for (const refund of refunds) outcomes.push(await reconcile(refund));
  const outcome = (["refund_failed", "refunded", "skipped"] as const).find((o) => outcomes.includes(o)) ?? "foreign";
  return { outcome, institutionId: refunds.find((r) => r.institutionId)?.institutionId ?? null };
}
