import { and, eq, exists, isNull, like, lt, notExists, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { ledgerEntry, moneyDiscrepancy } from "@/server/db/schema";

import { withLease } from "./lease";
import {
  MANUAL_REFUND_PREFIX,
  ledgerRefundBlocker,
  recordDiscrepancy,
  recordRefundFailure,
  type Ids,
} from "./discrepancy";
import { GatewayError, errorFacts, isLiveRefund, stripeGateway, type NewRefund, type Refund } from "./stripe";

const HOUR_MS = 60 * 60 * 1000;
const RETRY_GRACE_MS = 5 * 60 * 1000;
const RETRY_LIMIT = 20;
const RETRY_LEASE_MS = 5 * 60 * 1000;
const UNKNOWN_INTENT_GIVE_UP_MS = 24 * HOUR_MS;
export const SWEEP_BUDGET_MS = 30_000;

export type RefundOutcome = "refunded" | "refund_failed" | "flagged" | "in_flight" | "skipped" | "foreign";

type RefundRow = Ids & {
  id: string;
  amountMinor: number;
  currency: string;
  occurredAt: Date;
  paymentIntentId: string;
};

/** Stripe keeps a failed response under its key for 24h, so a retry past one moves to a fresh key each hour. */
export function retryKey(base: string, since: Date): string {
  return `${base}:${Math.floor((Date.now() - since.getTime()) / HOUR_MS)}`;
}

/**
 * The base key first, so a retry overlapping a call still in flight gets Stripe's 409 or its answer.
 * Only a retry whose base key Stripe answers from its cache with a 5xx moves on, once nothing turned up.
 */
export async function createRefund(
  params: Omit<NewRefund, "idempotencyKey">,
  base: string,
  retrySince: Date | null,
  lookAgain: () => Promise<Refund | undefined>,
): Promise<Refund> {
  const gateway = stripeGateway();
  try {
    return await gateway.refund({ ...params, idempotencyKey: base });
  } catch (error) {
    if (!retrySince || !(error instanceof GatewayError) || !error.replayed || (error.status ?? 0) < 500) throw error;
    const found = await lookAgain();
    if (found) return found;
    return gateway.refund({ ...params, idempotencyKey: retryKey(base, retrySince) });
  }
}

const purchase = alias(ledgerEntry, "purchase");

const boughtThroughStripe = and(
  eq(purchase.engagementId, ledgerEntry.engagementId),
  eq(purchase.institutionId, ledgerEntry.institutionId),
  eq(purchase.type, "package_purchase"),
  like(purchase.stripeReference, "pi\\_%"),
);
const unstampedRefund = and(eq(ledgerEntry.type, "refund"), isNull(ledgerEntry.stripeReference));
const blocked = () => ledgerRefundBlocker(ledgerEntry.id, ledgerEntry.institutionId);

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
    .innerJoin(purchase, boughtThroughStripe)
    .where(and(unstampedRefund, notExists(blocked()), ...where))
    .orderBy(sql`random()`)
    .limit(limit);
  return rows.map((row) => ({ ...row, paymentIntentId: row.paymentIntentId! }));
}

/** Rows waiting on ops, counted so the sweep reports them rather than passing over them in silence. */
async function blockedRefunds(institutionId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ledgerEntry)
    .innerJoin(purchase, boughtThroughStripe)
    .where(and(unstampedRefund, exists(blocked()), eq(ledgerEntry.institutionId, institutionId)));
  return row?.n ?? 0;
}

async function stamp(row: Ids & { id: string }, reference: string): Promise<void> {
  await db
    .update(ledgerEntry)
    .set({ stripeReference: reference })
    .where(
      and(
        eq(ledgerEntry.id, row.id),
        eq(ledgerEntry.institutionId, row.institutionId),
        eq(ledgerEntry.type, "refund"),
        isNull(ledgerEntry.stripeReference),
      ),
    );
}

type Settling = Omit<RefundRow, "occurredAt">;

async function fail(row: Settling, refund: Refund | null): Promise<RefundOutcome> {
  await recordRefundFailure(row, {
    refund,
    paymentIntentId: row.paymentIntentId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    ledgerEntryId: row.id,
  });
  return "refund_failed";
}

async function settle(row: Settling, refund: Refund): Promise<RefundOutcome> {
  await stamp(row, refund.id);
  return isLiveRefund(refund) ? "refunded" : fail(row, refund);
}

/** Ours (live first), or a live refund on the charge that is not, such as one made in the Dashboard. */
async function onCharge(row: Settling): Promise<{ mine?: Refund; foreign?: Refund }> {
  const listed = await stripeGateway().listRefunds(row.paymentIntentId);
  const mine = listed.filter((r) => r.ledgerEntryId === row.id);
  return {
    mine: mine.find(isLiveRefund) ?? mine.at(0),
    foreign: listed.find((r) => r.ledgerEntryId !== row.id && isLiveRefund(r)),
  };
}

async function settleFound(row: Settling, found: { mine?: Refund; foreign?: Refund }): Promise<RefundOutcome | null> {
  if (found.mine) return settle(row, found.mine);
  if (!found.foreign) return null;
  console.error(`[refund] ${row.paymentIntentId} already carries ${found.foreign.id}, not ours; flagged for ops`);
  await recordDiscrepancy(row, {
    kind: "ledger_vs_stripe_charge",
    stripeReference: found.foreign.id,
    ledgerEntryId: row.id,
    ledgerAmountMinor: row.amountMinor,
    stripeAmountMinor: found.foreign.amountMinor,
    currency: row.currency,
  });
  return "flagged";
}

/** No fee row means no charge was ever recorded at Stripe: a PaymentIntent fulfil wrote itself, never a real one. */
async function neverCharged(row: Settling): Promise<boolean> {
  const fees = await db
    .select({ id: ledgerEntry.id })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.engagementId, row.engagementId),
        eq(ledgerEntry.institutionId, row.institutionId),
        eq(ledgerEntry.type, "processor_fee"),
      ),
    )
    .limit(1);
  return fees.length === 0;
}

/**
 * A PaymentIntent Stripe still does not know a day on, and that never had a fee recorded (seeded
 * `pi_test_…` ids), is flagged rather than retried forever. A paid one is never flagged on a 404.
 */
async function issue(row: RefundRow, retry: boolean): Promise<RefundOutcome> {
  try {
    return await attempt(row, retry);
  } catch (error) {
    const stale = Date.now() - row.occurredAt.getTime() > UNKNOWN_INTENT_GIVE_UP_MS;
    if (!(retry && stale && error instanceof GatewayError && error.missing && (await neverCharged(row)))) throw error;
    return fail(row, null);
  }
}

async function attempt(row: RefundRow, retry: boolean): Promise<RefundOutcome> {
  const settled = await settleFound(row, await onCharge(row));
  if (settled) return settled;

  let refund: Refund;
  try {
    refund = await createRefund(
      {
        paymentIntentId: row.paymentIntentId,
        engagementId: row.engagementId,
        institutionId: row.institutionId,
        amountMinor: row.amountMinor,
        ledgerEntryId: row.id,
      },
      `refund:${row.id}`,
      retry ? row.occurredAt : null,
      async () => (await onCharge(row)).mine,
    );
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.inFlight) return "in_flight";
    if (!error.refused) throw error;
    return (await settleFound(row, await onCharge(row))) ?? fail(row, null);
  }
  return settle(row, refund);
}

export async function refundThroughStripe(ids: Ids): Promise<RefundOutcome> {
  const [row] = await unstampedRefunds(
    [eq(ledgerEntry.engagementId, ids.engagementId), eq(ledgerEntry.institutionId, ids.institutionId)],
    1,
  );
  return row ? issue(row, false) : "skipped";
}

/**
 * Rows whose after-commit call died. The grace keeps the sweep off a call still in flight, and the lease
 * keeps a second sweep off this campus, so two never race onto different hour-suffixed keys.
 */
export async function retryUnstampedRefunds(
  institutionId: string,
  deadline: number,
): Promise<{ settled: number; flagged: number; blocked: number; failed: number }> {
  const counts = await withLease(institutionId, "card-refund-retry", RETRY_LEASE_MS, () => retryCampus(institutionId, deadline));
  return { ...(counts ?? { settled: 0, flagged: 0, failed: 0 }), blocked: await blockedRefunds(institutionId) };
}

async function retryCampus(institutionId: string, deadline: number) {
  const rows = await unstampedRefunds(
    [eq(ledgerEntry.institutionId, institutionId), lt(ledgerEntry.occurredAt, new Date(Date.now() - RETRY_GRACE_MS))],
    RETRY_LIMIT,
  );
  const counts = { settled: 0, flagged: 0, failed: 0 };
  for (const [index, row] of rows.entries()) {
    if (index > 0 && Date.now() > deadline) break;
    try {
      const outcome = await issue(row, true);
      if (outcome === "refunded") counts.settled += 1;
      else if (outcome === "refund_failed" || outcome === "flagged") counts.flagged += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`[refund] retry failed for ${row.id}`, errorFacts(error));
    }
  }
  return counts;
}

/**
 * Ops settled the discrepancy by hand. On a ledger refund it also stamps that row `manual:<discrepancy id>`
 * in the same transaction, so the row stays the engagement's one refund and no sweep sees it again.
 */
export async function recordManualRefund(params: {
  discrepancyId: string;
  institutionId: string;
  note: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const scope = and(
      eq(moneyDiscrepancy.id, params.discrepancyId),
      eq(moneyDiscrepancy.institutionId, params.institutionId),
      isNull(moneyDiscrepancy.resolvedAt),
    );
    const [found] = await tx
      .select({ ledgerEntryId: moneyDiscrepancy.ledgerEntryId })
      .from(moneyDiscrepancy)
      .where(scope)
      .for("update");
    if (!found) return false;

    if (found.ledgerEntryId) {
      await tx
        .update(ledgerEntry)
        .set({ stripeReference: `${MANUAL_REFUND_PREFIX}${params.discrepancyId}` })
        .where(
          and(
            eq(ledgerEntry.id, found.ledgerEntryId),
            eq(ledgerEntry.institutionId, params.institutionId),
            eq(ledgerEntry.type, "refund"),
            isNull(ledgerEntry.stripeReference),
          ),
        );
    }
    await tx.update(moneyDiscrepancy).set({ resolvedAt: new Date(), resolutionNote: params.note }).where(scope);
    return true;
  });
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
