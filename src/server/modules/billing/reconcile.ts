import { isDeepStrictEqual } from "node:util";

import { and, desc, eq, exists, gt, inArray, isNull, like, lt, notExists, or, sql, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { engagement, ledgerEntry, moneyDiscrepancy, paymentDispute, tutorProfile } from "@/server/db/schema";

import { syncCheckout } from "./checkout-session";
import { ledgerRowBlocker, recordDiscrepancy, type Ids } from "./discrepancy";
import { handleDisputeEvent } from "./disputes";
import { claim, release, withLease } from "./lease";
import { neverCharged, reconcileRefund } from "./refunds";
import { GatewayError, errorFacts, stripeGateway, type Payment, type Transfer } from "./stripe";
import { applyTransfer } from "./transfers";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 7 * DAY_MS;
const LEASE_MS = 5 * 60 * 1000;
const DAILY = "reconciliation-daily";
const DAILY_MS = 23 * 60 * 60 * 1000;
const LIMIT = 20;
const IMPATIENT = { patient: false };

/** `flagged` counts discrepancies raised on the campus while the run held it. */
export type ReconcileCounts = { checked: number; flagged: number; resolved: number; failed: number };

const NONE: ReconcileCounts = { checked: 0, flagged: 0, resolved: 0, failed: 0 };

/** The key cannot see a payment Stripe charged. Flagging on that would bury the real divergences, so the campus stops. */
class KeyMismatch extends Error {}

type Charged = Ids & { paymentIntentId: string };
type Reconciling = Charged & { purchaseMinor: number; currency: string };
type Outcome = "resolved" | null;

const purchase = alias(ledgerEntry, "purchase");
const activity = alias(ledgerEntry, "activity");
const fee = alias(ledgerEntry, "fee");
const failed = alias(moneyDiscrepancy, "failed");

const boughtThroughStripe = and(
  eq(purchase.engagementId, engagement.id),
  eq(purchase.institutionId, engagement.institutionId),
  eq(purchase.type, "package_purchase"),
  like(purchase.stripeReference, "pi\\_%"),
);

/** Active in the last week and not compared in the last day, longest-waiting first. */
function dueEngagements(institutionId: string) {
  const now = Date.now();
  return db
    .select({
      engagementId: engagement.id,
      institutionId: engagement.institutionId,
      paymentIntentId: sql<string>`${purchase.stripeReference}`,
      purchaseMinor: purchase.amountMinor,
      currency: purchase.currency,
    })
    .from(engagement)
    .innerJoin(purchase, boughtThroughStripe)
    .where(
      and(
        eq(engagement.institutionId, institutionId),
        or(isNull(engagement.reconciledAt), lt(engagement.reconciledAt, new Date(now - DAY_MS))),
        exists(
          db
            .select({ id: activity.id })
            .from(activity)
            .where(
              and(
                eq(activity.engagementId, engagement.id),
                eq(activity.institutionId, engagement.institutionId),
                gt(activity.occurredAt, new Date(now - ACTIVE_MS)),
              ),
            ),
        ),
      ),
    )
    .orderBy(sql`${engagement.reconciledAt} asc nulls first`)
    .limit(LIMIT);
}

async function paymentOf(charged: Charged): Promise<Payment | null> {
  try {
    return await stripeGateway().retrievePayment(charged.paymentIntentId);
  } catch (error) {
    if (!(error instanceof GatewayError && error.missing)) throw error;
    if (!(await neverCharged(charged))) {
      console.error(
        `[reconcile] Stripe does not know ${charged.paymentIntentId}, which it charged: STRIPE_SECRET_KEY is for another account. Campus ${charged.institutionId} stopped with nothing flagged.`,
      );
      throw new KeyMismatch(`STRIPE_SECRET_KEY cannot see ${charged.paymentIntentId}`);
    }
    console.warn(`[reconcile] ${charged.paymentIntentId} was never charged at Stripe; ${charged.engagementId} not compared`);
    return null;
  }
}

const refundFailed = (ledgerEntryId: AnyColumn, institutionId: AnyColumn) =>
  db
    .select({ id: failed.id })
    .from(failed)
    .where(and(eq(failed.kind, "refund_failed"), eq(failed.ledgerEntryId, ledgerEntryId), eq(failed.institutionId, institutionId)));

/** Refunds that failed are left out of what was refunded: their own flag already carries that money. */
async function ledgerOf(ids: Ids) {
  const [row] = await db
    .select({
      inFlightRefunds: sql<number>`count(*) filter (where ${ledgerEntry.type} = 'refund' and ${ledgerEntry.stripeReference} is null)::int`,
      inFlightTransfers: sql<number>`count(*) filter (where ${ledgerEntry.type} = 'tutor_transfer' and ${ledgerEntry.stripeReference} is null)::int`,
      refundedMinor: sql<number>`coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${ledgerEntry.type} = 'refund' and ${ledgerEntry.stripeReference} like 're\\_%' and ${notExists(refundFailed(ledgerEntry.id, ledgerEntry.institutionId))}), 0)::int`,
      transferredMinor: sql<number>`(
        coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${ledgerEntry.type} = 'tutor_transfer' and ${ledgerEntry.stripeReference} like 'tr\\_%'), 0)
        - coalesce(sum(${ledgerEntry.amountMinor}) filter (where ${ledgerEntry.type} = 'transfer_reversal'), 0)
      )::int`,
    })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, ids.engagementId), eq(ledgerEntry.institutionId, ids.institutionId)));
  return row;
}

type Ledger = Awaited<ReturnType<typeof ledgerOf>>;
type Gap = { ledgerNetMinor: number; stripeNetMinor: number; currency: string };

function chargeGap(e: Reconciling, payment: Payment, ledger: Ledger): Gap | null {
  if (ledger.inFlightRefunds > 0) return null;
  const ledgerNetMinor = e.purchaseMinor - ledger.refundedMinor;
  const stripeNetMinor = payment.amountMinor - payment.refundedMinor;
  if (ledgerNetMinor === stripeNetMinor && payment.currency === e.currency) return null;
  return { ledgerNetMinor, stripeNetMinor, currency: payment.currency };
}

/** Stripe's side counts every transfer in the group and every reversal, ours or not. */
function transfersGap(e: Reconciling, transfers: Transfer[], ledger: Ledger): Gap | null {
  if (ledger.inFlightTransfers > 0) return null;
  const stripeNetMinor = transfers.reduce(
    (sum, t) => sum + t.amountMinor - t.reversals.reduce((reversed, r) => reversed + r.amountMinor, 0),
    0,
  );
  return stripeNetMinor === ledger.transferredMinor ? null : { ledgerNetMinor: ledger.transferredMinor, stripeNetMinor, currency: e.currency };
}

async function gaps(e: Reconciling, payment: Payment, transfers: Transfer[]) {
  const ledger = await ledgerOf(e);
  return { charge: chargeGap(e, payment, ledger), transfers: transfersGap(e, transfers, ledger) };
}

async function openFlag(ids: Ids, kind: (typeof moneyDiscrepancy.$inferSelect)["kind"]): Promise<boolean> {
  const rows = await db
    .select({ id: moneyDiscrepancy.id })
    .from(moneyDiscrepancy)
    .where(
      and(
        eq(moneyDiscrepancy.engagementId, ids.engagementId),
        eq(moneyDiscrepancy.institutionId, ids.institutionId),
        eq(moneyDiscrepancy.kind, kind),
        isNull(moneyDiscrepancy.resolvedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function flagCharge(e: Reconciling, gap: Gap): Promise<void> {
  console.error(`[reconcile] ${e.paymentIntentId} nets ${gap.stripeNetMinor} ${gap.currency} at Stripe, ${gap.ledgerNetMinor} ${e.currency} on the ledger; flagged for ops`);
  await recordDiscrepancy(e, {
    kind: "ledger_vs_stripe_charge",
    stripeReference: e.paymentIntentId,
    ledgerAmountMinor: gap.ledgerNetMinor,
    stripeAmountMinor: gap.stripeNetMinor,
    currency: e.currency,
  });
}

async function flagTransfers(e: Reconciling, gap: Gap): Promise<void> {
  if (await openFlag(e, "ledger_vs_stripe_transfers")) return;
  console.error(`[reconcile] ${e.engagementId} transferred ${gap.stripeNetMinor} at Stripe, ${gap.ledgerNetMinor} on the ledger; flagged for ops`);
  await recordDiscrepancy(e, {
    kind: "ledger_vs_stripe_transfers",
    ledgerAmountMinor: gap.ledgerNetMinor,
    stripeAmountMinor: gap.stripeNetMinor,
    currency: e.currency,
  });
}

/** Rows a sweep should have stamped by now and that no discrepancy has stopped. */
const staleRows = (ids: Ids) =>
  db
    .select({ amountMinor: ledgerEntry.amountMinor, currency: ledgerEntry.currency })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.engagementId, ids.engagementId),
        eq(ledgerEntry.institutionId, ids.institutionId),
        inArray(ledgerEntry.type, ["refund", "tutor_transfer"]),
        isNull(ledgerEntry.stripeReference),
        lt(ledgerEntry.occurredAt, new Date(Date.now() - DAY_MS)),
        notExists(ledgerRowBlocker(ledgerEntry.id, ledgerEntry.institutionId)),
      ),
    )
    .orderBy(ledgerEntry.occurredAt)
    .limit(1);

/** Names no ledger row: a discrepancy on a row stops its retries for good, and this one should only be seen. */
async function flagStaleRows(ids: Ids): Promise<void> {
  const [stale] = await staleRows(ids);
  if (!stale || (await openFlag(ids, "unstamped_reference"))) return;
  console.error(`[reconcile] ${ids.engagementId} has a row unstamped for over a day; flagged for ops`);
  await recordDiscrepancy(ids, { kind: "unstamped_reference", ledgerAmountMinor: stale.amountMinor, currency: stale.currency });
}

async function reconcileEngagement(e: Reconciling): Promise<void> {
  const gateway = stripeGateway();
  const payment = await paymentOf(e);
  if (payment) {
    for (const refund of await gateway.listRefunds(e.paymentIntentId)) await reconcileRefund(refund);
    const transfers = await gateway.listTransfers(e.engagementId);
    for (const transfer of transfers) if (transfer.ledgerEntryId) await applyTransfer(transfer);
    const seen = await gaps(e, payment, transfers);
    if (seen.charge || seen.transfers) {
      // Stripe is read before the ledger, so a refund or transfer stamped in between shows as a gap once; only a gap seen twice is real.
      const again = await gaps(e, await gateway.retrievePayment(e.paymentIntentId), await gateway.listTransfers(e.engagementId));
      if (seen.charge && isDeepStrictEqual(seen.charge, again.charge)) await flagCharge(e, seen.charge);
      if (seen.transfers && isDeepStrictEqual(seen.transfers, again.transfers)) await flagTransfers(e, seen.transfers);
    }
  }
  await flagStaleRows(e);
  await db
    .update(engagement)
    .set({ reconciledAt: new Date() })
    .where(and(eq(engagement.id, e.engagementId), eq(engagement.institutionId, e.institutionId)));
}

async function resolve(flag: { id: string; institutionId: string }, note: string): Promise<Outcome> {
  const resolved = await db
    .update(moneyDiscrepancy)
    .set({ resolvedAt: new Date(), resolutionNote: note, resolvedByUserId: null })
    .where(
      and(
        eq(moneyDiscrepancy.id, flag.id),
        eq(moneyDiscrepancy.institutionId, flag.institutionId),
        isNull(moneyDiscrepancy.resolvedAt),
      ),
    )
    .returning({ id: moneyDiscrepancy.id });
  return resolved.length > 0 ? "resolved" : null;
}

const openFlags = (institutionId: string, kind: (typeof moneyDiscrepancy.$inferSelect)["kind"]) =>
  and(
    eq(moneyDiscrepancy.institutionId, institutionId),
    eq(moneyDiscrepancy.kind, kind),
    isNull(moneyDiscrepancy.resolvedAt),
  );

/**
 * A released checkout's flag waits a day, until no Session can still be paid, then goes when Stripe holds no
 * payment for it; a payment found is refunded and the flag stays for ops. A stale-row flag goes once every row is stamped.
 */
async function settleUnstampedFlag(flag: Ids & { id: string; status: string; detectedAt: Date }): Promise<Outcome> {
  if (flag.status !== "cancelled") {
    return (await staleRows(flag)).length > 0
      ? null
      : resolve(flag, "Reconciliation: every row now carries its Stripe reference.");
  }
  if (Date.now() - flag.detectedAt.getTime() < DAY_MS) return null;
  const paid = await stripeGateway().findPaidCheckout(flag.engagementId);
  if (!paid) return resolve(flag, "Reconciliation: Stripe holds no payment for this checkout.");
  await syncCheckout(paid.id, IMPATIENT);
  return null;
}

/** A Session Stripe once said did not exist. Paid since, it is refunded and the flag stays for ops. */
async function settleMissingSession(flag: { id: string; institutionId: string; sessionId: string }): Promise<Outcome> {
  let session;
  try {
    session = await stripeGateway().retrieveCheckout(flag.sessionId);
  } catch (error) {
    if (error instanceof GatewayError && error.missing) return null;
    throw error;
  }
  if (session.status === "expired") return resolve(flag, "Reconciliation: Stripe finds this Session now; it expired unpaid.");
  if (session.status === "complete" && session.paymentStatus === "paid") await syncCheckout(session.id, IMPATIENT);
  return null;
}

async function flagOrphanedAccounts(institutionId: string): Promise<void> {
  const accounts = (await stripeGateway().listAccounts()).filter((account) => account.institutionId === institutionId);
  if (accounts.length === 0) return;
  const held = await db
    .select({ id: tutorProfile.stripeAccountId })
    .from(tutorProfile)
    .where(
      and(
        eq(tutorProfile.institutionId, institutionId),
        inArray(
          tutorProfile.stripeAccountId,
          accounts.map((account) => account.id),
        ),
      ),
    );
  const heldIds = new Set(held.map((row) => row.id));
  for (const account of accounts) {
    if (heldIds.has(account.id)) continue;
    await recordDiscrepancy({ engagementId: null, institutionId }, { kind: "orphaned_account", stripeReference: account.id });
  }
}

/** The newest charged purchase is asked for first, so a key for another account stops the day's pass before it resolves anything. */
async function checkKey(institutionId: string): Promise<void> {
  const [charged] = await db
    .select({
      engagementId: purchase.engagementId,
      institutionId: purchase.institutionId,
      paymentIntentId: sql<string>`${purchase.stripeReference}`,
    })
    .from(purchase)
    .where(
      and(
        eq(purchase.institutionId, institutionId),
        eq(purchase.type, "package_purchase"),
        like(purchase.stripeReference, "pi\\_%"),
        exists(
          db
            .select({ id: fee.id })
            .from(fee)
            .where(
              and(
                eq(fee.engagementId, purchase.engagementId),
                eq(fee.institutionId, purchase.institutionId),
                eq(fee.type, "processor_fee"),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(purchase.occurredAt))
    .limit(1);
  if (charged) await paymentOf(charged);
}

const unstampedFlags = (institutionId: string) =>
  db
    .select({
      id: moneyDiscrepancy.id,
      engagementId: engagement.id,
      institutionId: moneyDiscrepancy.institutionId,
      status: engagement.status,
      detectedAt: moneyDiscrepancy.detectedAt,
    })
    .from(moneyDiscrepancy)
    .innerJoin(
      engagement,
      and(eq(engagement.id, moneyDiscrepancy.engagementId), eq(engagement.institutionId, moneyDiscrepancy.institutionId)),
    )
    .where(openFlags(institutionId, "unstamped_reference"))
    .orderBy(moneyDiscrepancy.detectedAt)
    .limit(LIMIT);

const missingSessions = (institutionId: string) =>
  db
    .select({ id: moneyDiscrepancy.id, institutionId: moneyDiscrepancy.institutionId, sessionId: sql<string>`${moneyDiscrepancy.stripeReference}` })
    .from(moneyDiscrepancy)
    .where(and(openFlags(institutionId, "ledger_vs_stripe_charge"), like(moneyDiscrepancy.stripeReference, "cs\\_%")))
    .orderBy(moneyDiscrepancy.detectedAt)
    .limit(LIMIT);

const openDisputes = (institutionId: string) =>
  db
    .select({ id: paymentDispute.stripeDisputeId })
    .from(paymentDispute)
    .where(
      and(
        eq(paymentDispute.institutionId, institutionId),
        isNull(paymentDispute.resolvedAt),
        isNull(paymentDispute.closedAt),
      ),
    )
    .orderBy(paymentDispute.openedAt)
    .limit(LIMIT);

async function reconcileCampus(institutionId: string, deadline: number): Promise<Omit<ReconcileCounts, "flagged">> {
  const counts = { checked: 0, resolved: 0, failed: 0 };
  /** False when the deadline stopped it before the last item. */
  const each = async <T>(items: T[], subject: (item: T) => string, work: (item: T) => Promise<Outcome>) => {
    for (const [index, item] of items.entries()) {
      if (index > 0 && Date.now() > deadline) return false;
      try {
        if ((await work(item)) === "resolved") counts.resolved += 1;
      } catch (error) {
        if (error instanceof KeyMismatch) throw error;
        counts.failed += 1;
        console.error(`[reconcile] ${subject(item)} failed`, errorFacts(error));
      }
    }
    return true;
  };

  await each(await dueEngagements(institutionId), (e) => e.engagementId, async (e) => {
    await reconcileEngagement(e);
    counts.checked += 1;
    return null;
  });

  const daily = async () => {
    await checkKey(institutionId);
    return (
      (await each(await unstampedFlags(institutionId), (flag) => flag.id, settleUnstampedFlag)) &&
      (await each(await missingSessions(institutionId), (flag) => flag.sessionId, settleMissingSession)) &&
      (await each(await openDisputes(institutionId), (dispute) => dispute.id, async (dispute) => {
        await handleDisputeEvent(dispute.id);
        return null;
      })) &&
      (await each([institutionId], (id) => `orphaned account scan of ${id}`, async (id) => {
        await flagOrphanedAccounts(id);
        return null;
      }))
    );
  };

  if (Date.now() > deadline) return counts;
  const heldUntil = await claim(institutionId, DAILY, DAILY_MS);
  if (!heldUntil) return counts;
  let finished = false;
  try {
    finished = await daily();
  } finally {
    // A pass the key or the deadline cut short runs again on the next cron run, not tomorrow.
    if (!finished) await release(institutionId, DAILY, heldUntil);
  }
  return counts;
}

/**
 * Compares each engagement active in the last week with Stripe once a day, spread over the cron runs, and once a
 * day settles the flags Stripe can now answer, refreshes open disputes and looks for Connect accounts no tutor holds.
 * It never corrects the ledger: a divergence becomes a discrepancy, which pauses the engagement's transfers.
 */
export async function runReconciliation(institutionId: string, deadline: number): Promise<ReconcileCounts> {
  const started = Date.now();
  const counts = await withLease(institutionId, "reconciliation", LEASE_MS, () => reconcileCampus(institutionId, deadline));
  if (!counts) return NONE;
  const [raised] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(moneyDiscrepancy)
    .where(
      and(
        eq(moneyDiscrepancy.institutionId, institutionId),
        sql`${moneyDiscrepancy.detectedAt} >= now() - ${Date.now() - started} * interval '1 millisecond'`,
      ),
    );
  return { ...counts, flagged: raised.n };
}
