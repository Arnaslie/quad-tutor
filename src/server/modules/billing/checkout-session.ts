import { setTimeout as sleep } from "node:timers/promises";

import { and, eq, inArray, isNotNull, isNull, like, lt, notExists, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, moneyDiscrepancy } from "@/server/db/schema";
import { fulfilCheckout, releaseCheckout, type FulfilResult } from "@/server/modules/engagements/checkout";
import {
  PurchaseError,
  checkoutDetails,
  type Checkout,
  type PurchaseResult,
} from "@/server/modules/engagements/purchase";
import type { Actor } from "@/server/modules/identity/actor";

import { GatewayError, errorFacts, stripeGateway, type ChargeFee, type CheckoutSession } from "./stripe";

const RESUME_MARGIN_MS = 5 * 60 * 1000;
const STRIPE_MIN_EXPIRY_MS = 30 * 60 * 1000;
const SWEEP_GRACE_MS = 2 * 60 * 1000;
const SWEEP_LIMIT = 20;
const UNAVAILABLE = "Payments are unavailable right now. Nothing was charged; try again in a minute.";
const UNREACHABLE =
  "We could not reach our payment provider. Try again in a minute. If you already paid, your booking appears under Sessions shortly.";
const SWEEP_BUDGET_MS = 30_000;

type Ids = { engagementId: string; institutionId: string };
type Patience = { patient: boolean };
const PATIENT: Patience = { patient: true };
const IMPATIENT: Patience = { patient: false };

export type SyncOutcome =
  | "open"
  | "unpaid"
  | "fulfilled"
  | "released"
  | "refunded"
  | "settled"
  | "awaiting_fee"
  | "refund_failed"
  | "foreign";

export function appUrl(path: string): string {
  return `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}${path}`;
}

function sessionParams(checkout: Checkout) {
  return {
    engagementId: checkout.engagementId,
    institutionId: checkout.institutionId,
    amountMinor: checkout.amountMinor,
    currency: checkout.currency,
    description: checkout.description,
    customerEmail: checkout.customerEmail,
    expiresAt: checkout.expiresAt,
    successUrl: appUrl(`/sessions?package=${checkout.engagementId}`),
    cancelUrl: appUrl(`/checkout/cancel?package=${checkout.engagementId}`),
  };
}

/** True when the row now carries this Session id, whoever stamped it. */
async function stamp(ids: Ids, sessionId: string): Promise<boolean> {
  const stamped = await db
    .update(engagement)
    .set({ stripeCheckoutSessionId: sessionId })
    .where(
      and(
        eq(engagement.id, ids.engagementId),
        eq(engagement.institutionId, ids.institutionId),
        isNull(engagement.stripeCheckoutSessionId),
        eq(engagement.status, "pending_payment"),
      ),
    )
    .returning({ id: engagement.id });
  if (stamped.length > 0) return true;

  const [row] = await db
    .select({ status: engagement.status, sessionId: engagement.stripeCheckoutSessionId })
    .from(engagement)
    .where(and(eq(engagement.id, ids.engagementId), eq(engagement.institutionId, ids.institutionId)));
  return row?.status === "pending_payment" && row.sessionId === sessionId;
}

/** Create and stamp both finish before the caller redirects. Null means do not redirect. */
async function openCheckout(checkout: Checkout): Promise<string | null> {
  const ids = { engagementId: checkout.engagementId, institutionId: checkout.institutionId };
  let session: CheckoutSession;
  try {
    session = await stripeGateway().createCheckout(sessionParams(checkout));
  } catch (error) {
    console.error(`[checkout] create failed for ${checkout.engagementId}`, errorFacts(error));
    throw new PurchaseError(UNAVAILABLE);
  }

  if (await stamp(ids, session.id)) return session.url;
  await stripeGateway()
    .expireCheckout(session.id)
    .catch((error) => console.error(`[checkout] could not expire unstamped ${session.id}`, errorFacts(error)));
  return null;
}

const isMissing = (error: unknown) => error instanceof GatewayError && error.missing;

async function resumeUrl(checkout: Checkout): Promise<string | null> {
  const left = checkout.expiresAt.getTime() - Date.now();
  if (!checkout.stripeCheckoutSessionId) {
    return left < STRIPE_MIN_EXPIRY_MS ? null : openCheckout(checkout);
  }
  if (left < RESUME_MARGIN_MS) return null;
  try {
    const session = await stripeGateway().retrieveCheckout(checkout.stripeCheckoutSessionId);
    return session.status === "open" ? session.url : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Where the purchase action sends the student: Stripe's hosted page, or the sessions page once paid. */
export async function checkoutRedirect(
  institutionId: string,
  buy: () => Promise<PurchaseResult>,
): Promise<{ url: string; fulfilled: boolean }> {
  let fulfilled = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await buy();
      if (result.outcome === "paid") return { url: `/sessions?package=${result.engagementId}`, fulfilled };

      if (result.outcome === "checkout") {
        const url = await resumeUrl(result.checkout);
        if (url) return { url, fulfilled };
      }
      const settled = await settleCheckout({ engagementId: result.engagementId, institutionId });
      fulfilled ||= settled === "fulfilled";
    }
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    console.error("[checkout] gateway error", errorFacts(error));
    throw new PurchaseError(UNREACHABLE);
  }
  throw new PurchaseError("Your last checkout is still closing. Try again in a minute.");
}

async function purchaseRecorded(ids: Ids, paymentIntentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: ledgerEntry.id })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.institutionId, ids.institutionId),
        eq(ledgerEntry.type, "package_purchase"),
        eq(ledgerEntry.stripeReference, paymentIntentId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function recordDiscrepancy(
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

const live = (refund: { status: string | null }) => refund.status !== "failed" && refund.status !== "canceled";

async function refundPayment(ids: Ids, paymentIntentId: string, discrepancyId?: string): Promise<boolean> {
  const gateway = stripeGateway();
  const refund =
    (await gateway.listRefunds(paymentIntentId)).find(live) ??
    (await gateway.refund({ paymentIntentId, ...ids }));
  if (!live(refund)) {
    console.error(`[checkout] refund ${refund.id} for ${paymentIntentId} is ${refund.status}; not recorded`);
    return false;
  }
  console.warn(`[checkout] refunded ${paymentIntentId} for ${ids.engagementId}: ${refund.id}`);

  if (discrepancyId) {
    await db
      .update(moneyDiscrepancy)
      .set({ refundReference: refund.id })
      .where(
        and(
          eq(moneyDiscrepancy.id, discrepancyId),
          eq(moneyDiscrepancy.institutionId, ids.institutionId),
          isNull(moneyDiscrepancy.refundReference),
        ),
      );
  }
  return true;
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const pg = cause as Error & { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === constraint) return true;
  }
  return false;
}

/** Stripe attaches the balance transaction a few seconds after the charge; the fee is written only at fulfil. */
async function chargeFee(paymentIntentId: string, patience: Patience): Promise<ChargeFee> {
  const attempts = patience.patient ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(1_500 * attempt);
    const fee = await stripeGateway().chargeFee(paymentIntentId);
    if (fee) return fee;
  }
  return null;
}

/** Only a payment fulfil will accept needs its fee; refund paths never wait for one. */
async function fulfillable(ids: Ids, session: CheckoutSession): Promise<boolean> {
  const [row] = await db
    .select({
      status: engagement.status,
      sessionId: engagement.stripeCheckoutSessionId,
      priceMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
    })
    .from(engagement)
    .where(and(eq(engagement.id, ids.engagementId), eq(engagement.institutionId, ids.institutionId)));
  return (
    row?.status === "pending_payment" &&
    (row.sessionId === null || row.sessionId === session.id) &&
    row.priceMinor === session.amountTotal &&
    row.currency === session.currency?.toLowerCase()
  );
}

async function fulfil(
  session: CheckoutSession,
  ids: Ids,
  paymentIntentId: string,
  patience: Patience,
): Promise<SyncOutcome> {
  let fee: ChargeFee = null;
  if (await fulfillable(ids, session)) {
    fee = await chargeFee(paymentIntentId, patience);
    if (!fee && patience.patient) {
      throw new GatewayError(`The charge for ${paymentIntentId} has no balance transaction yet.`);
    }
    if (!fee) return "awaiting_fee";
  }

  let result: FulfilResult | null = null;
  let clash = false;
  try {
    result = await fulfilCheckout({
      ...ids,
      checkoutSessionId: session.id,
      payment: {
        paymentIntentId,
        amountTotal: session.amountTotal ?? 0,
        currency: session.currency ?? "",
        chargeFeeMinor: fee?.feeMinor,
        balanceTransactionId: fee?.balanceTransactionId,
      },
    });
  } catch (error) {
    if (!uniqueViolation(error, "ledger_entry_stripe_reference_idx")) throw error;
    clash = true;
    console.error(
      `[checkout] ${paymentIntentId} or its charge is already on another ledger row; releasing ${ids.engagementId}`,
    );
    await releaseCheckout({ ...ids, checkoutSessionId: session.id });
  }

  if (result?.outcome === "fulfilled") return "fulfilled";
  if (result?.outcome === "missing") {
    console.warn(`[checkout] ${session.id} names engagement ${ids.engagementId}, which is not here`);
    return "foreign";
  }
  if (await purchaseRecorded(ids, paymentIntentId)) {
    if (clash) {
      await recordDiscrepancy(ids, {
        kind: "ledger_vs_stripe_charge",
        stripeReference: paymentIntentId,
        stripeAmountMinor: session.amountTotal,
        currency: session.currency ?? "usd",
      });
    }
    return "settled";
  }
  const discrepancyId =
    result?.outcome === "discrepancy"
      ? result.discrepancyId
      : await recordDiscrepancy(ids, {
          kind: "ledger_vs_stripe_charge",
          stripeReference: paymentIntentId,
          stripeAmountMinor: session.amountTotal,
          currency: session.currency ?? "usd",
        });
  const refunded = await refundPayment(ids, paymentIntentId, discrepancyId ?? undefined);
  return refunded ? "refunded" : "refund_failed";
}

async function act(session: CheckoutSession, patience: Patience): Promise<SyncOutcome> {
  if (!session.engagementId || !session.institutionId) return "foreign";
  const ids = { engagementId: session.engagementId, institutionId: session.institutionId };

  if (session.status === "complete") {
    if (session.paymentStatus !== "paid" || !session.paymentIntentId) return "unpaid";
    return fulfil(session, ids, session.paymentIntentId, patience);
  }
  if (session.status === "expired") {
    const released = await releaseCheckout({ ...ids, checkoutSessionId: session.id });
    return released.outcome === "released" ? "released" : "settled";
  }
  return "open";
}

/** Acts on what Stripe says now, never on an event payload, so repeats and reordering are harmless. */
export async function syncCheckout(
  sessionId: string,
  patience = PATIENT,
): Promise<{ outcome: SyncOutcome; institutionId: string | null }> {
  const session = await stripeGateway().retrieveCheckout(sessionId);
  return { outcome: await act(session, patience), institutionId: session.institutionId };
}

const definitive = (error: unknown) =>
  error instanceof GatewayError && (error.idempotency || error.param === "expires_at");

/** Create was refused for good, so no Session can be recovered: look for a payment before letting go. */
async function closeUnstamped(checkout: Checkout): Promise<SyncOutcome> {
  const ids = { engagementId: checkout.engagementId, institutionId: checkout.institutionId };
  const paid = await stripeGateway().findPaidCheckout(checkout.engagementId);
  if (paid) return act(paid, PATIENT);

  const released = await releaseCheckout({ ...ids, checkoutSessionId: null });
  if (released.outcome !== "released") return "settled";
  await recordDiscrepancy(ids, {
    kind: "unstamped_reference",
    ledgerAmountMinor: checkout.amountMinor,
    currency: checkout.currency,
  });
  return "released";
}

/** The stamped Session does not exist for this key: nothing can be paid on it, so let the hold go. */
async function closeMissing(checkout: Checkout, sessionId: string): Promise<SyncOutcome> {
  const ids = { engagementId: checkout.engagementId, institutionId: checkout.institutionId };
  const released = await releaseCheckout({ ...ids, checkoutSessionId: sessionId });
  if (released.outcome !== "released") return "settled";
  await recordDiscrepancy(ids, {
    kind: "ledger_vs_stripe_charge",
    stripeReference: sessionId,
    ledgerAmountMinor: checkout.amountMinor,
    currency: checkout.currency,
  });
  return "released";
}

/** Ends a pending checkout: expire it if open, then act on Stripe's answer. Never releases on a transient error. */
export async function settleCheckout(ids: Ids): Promise<SyncOutcome> {
  const gateway = stripeGateway();
  const found = await checkoutDetails(db, ids);
  if (!found?.checkout || found.status !== "pending_payment") return "settled";
  const { checkout } = found;

  let sessionId = checkout.stripeCheckoutSessionId;
  if (!sessionId) {
    let recovered: CheckoutSession;
    try {
      recovered = await gateway.createCheckout(sessionParams(checkout));
    } catch (error) {
      if (!definitive(error)) throw error;
      console.warn(`[checkout] no Session to recover for ${ids.engagementId}`, errorFacts(error));
      return closeUnstamped(checkout);
    }
    if (!(await stamp(ids, recovered.id))) return "settled";
    sessionId = recovered.id;
  }

  let session: CheckoutSession;
  try {
    session = await gateway.retrieveCheckout(sessionId);
  } catch (error) {
    if (!isMissing(error)) throw error;
    console.warn(`[checkout] ${sessionId} does not exist at Stripe; releasing ${ids.engagementId}`);
    return closeMissing(checkout, sessionId);
  }
  if (session.status === "open") {
    try {
      session = await gateway.expireCheckout(sessionId);
    } catch (error) {
      console.warn(`[checkout] expire failed for ${sessionId}; asking Stripe again`, errorFacts(error));
      session = await gateway.retrieveCheckout(sessionId);
    }
  }
  return act(session, PATIENT);
}

/**
 * Money taken with nothing booked is recorded before its refund, so a refund that failed is retried here.
 * A PaymentIntent that is some engagement's purchase is legitimately booked and never refunded.
 */
async function retryDiscrepancyRefunds(
  institutionId: string,
  deadline: number,
): Promise<{ settled: number; failed: number }> {
  const rows = await db
    .select({
      id: moneyDiscrepancy.id,
      engagementId: moneyDiscrepancy.engagementId,
      paymentIntentId: moneyDiscrepancy.stripeReference,
    })
    .from(moneyDiscrepancy)
    .where(
      and(
        eq(moneyDiscrepancy.institutionId, institutionId),
        inArray(moneyDiscrepancy.kind, ["checkout_amount", "ledger_vs_stripe_charge"]),
        isNull(moneyDiscrepancy.refundReference),
        isNull(moneyDiscrepancy.resolvedAt),
        like(moneyDiscrepancy.stripeReference, "pi\\_%"),
        isNotNull(moneyDiscrepancy.engagementId),
        notExists(
          db
            .select({ id: ledgerEntry.id })
            .from(ledgerEntry)
            .where(
              and(
                eq(ledgerEntry.institutionId, institutionId),
                eq(ledgerEntry.type, "package_purchase"),
                eq(ledgerEntry.stripeReference, moneyDiscrepancy.stripeReference),
              ),
            ),
        ),
      ),
    )
    .orderBy(sql`random()`)
    .limit(SWEEP_LIMIT);

  let settled = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && Date.now() > deadline) break;
    if (!row.engagementId || !row.paymentIntentId) continue;
    try {
      const refunded = await refundPayment({ engagementId: row.engagementId, institutionId }, row.paymentIntentId, row.id);
      if (refunded) settled += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error(`[checkout] discrepancy refund still failing for ${row.id}`, errorFacts(error));
    }
  }
  return { settled, failed };
}

/** Past the deadline it starts only one row per campus, so later campuses' jobs still fit in maxDuration. */
export async function syncPendingCheckouts(
  institutionId: string,
  deadline = Date.now() + SWEEP_BUDGET_MS,
): Promise<{ settled: number; failed: number }> {
  const rows = await db
    .select({ engagementId: engagement.id, institutionId: engagement.institutionId })
    .from(engagement)
    .where(
      and(
        eq(engagement.institutionId, institutionId),
        eq(engagement.status, "pending_payment"),
        lt(engagement.checkoutExpiresAt, new Date(Date.now() - SWEEP_GRACE_MS)),
      ),
    )
    .orderBy(sql`random()`)
    .limit(SWEEP_LIMIT);

  let settled = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    if (index > 0 && Date.now() > deadline) break;
    try {
      await settleCheckout(row);
      settled += 1;
    } catch (error) {
      failed += 1;
      console.error(`[checkout] sweep could not settle ${row.engagementId}`, errorFacts(error));
    }
  }
  const refunds = await retryDiscrepancyRefunds(institutionId, deadline);
  return { settled: settled + refunds.settled, failed: failed + refunds.failed };
}

/** Reads only ever sync the viewer's own pending checkouts. */
export async function syncOwnCheckouts(actor: Actor): Promise<boolean> {
  const rows = await db
    .select({ sessionId: engagement.stripeCheckoutSessionId })
    .from(engagement)
    .where(
      and(
        eq(engagement.studentProfileId, actor.studentProfileId),
        eq(engagement.institutionId, actor.institutionId),
        eq(engagement.status, "pending_payment"),
        isNotNull(engagement.stripeCheckoutSessionId),
      ),
    )
    .limit(3);

  let fulfilled = false;
  for (const row of rows) {
    if (!row.sessionId) continue;
    const outcome = await syncCheckout(row.sessionId, IMPATIENT).catch((error) => {
      console.error(`[checkout] could not sync ${row.sessionId}`, errorFacts(error));
      return null;
    });
    fulfilled ||= outcome?.outcome === "fulfilled";
  }
  return fulfilled;
}

export type OwnCheckout = { status: (typeof engagement.$inferSelect)["status"]; kind: (typeof engagement.$inferSelect)["kind"] };

export async function ownCheckout(actor: Actor, engagementId: string): Promise<OwnCheckout | null> {
  const rows = await db
    .select({ status: engagement.status, kind: engagement.kind })
    .from(engagement)
    .where(
      and(
        eq(engagement.id, engagementId),
        eq(engagement.studentProfileId, actor.studentProfileId),
        eq(engagement.institutionId, actor.institutionId),
      ),
    )
    .limit(1);
  return rows.at(0) ?? null;
}

/** The student backed out on Stripe's page: expire the Session, then release the hold. */
export async function cancelCheckout(
  actor: Actor,
  engagementId: string,
): Promise<{ checkout: OwnCheckout | null; fulfilled: boolean }> {
  const before = await ownCheckout(actor, engagementId);
  if (before?.status !== "pending_payment") return { checkout: before, fulfilled: false };

  const settled = await settleCheckout({ engagementId, institutionId: actor.institutionId }).catch((error) => {
    console.error(`[checkout] cancel could not settle ${engagementId}`, errorFacts(error));
    return null;
  });
  return { checkout: await ownCheckout(actor, engagementId), fulfilled: settled === "fulfilled" };
}
