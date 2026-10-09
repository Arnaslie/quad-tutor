import { setTimeout as sleep } from "node:timers/promises";

import { and, asc, eq, isNotNull, isNull, lt } from "drizzle-orm";

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

import { GatewayError, stripeGateway, type ChargeFee, type CheckoutSession } from "./stripe";

const RESUME_MARGIN_MS = 5 * 60 * 1000;
const SWEEP_GRACE_MS = 2 * 60 * 1000;
const SWEEP_LIMIT = 20;
const UNAVAILABLE = "Payments are unavailable right now. Nothing was charged; try again in a minute.";

type Ids = { engagementId: string; institutionId: string };

export type SyncOutcome =
  | "open"
  | "unpaid"
  | "fulfilled"
  | "released"
  | "refunded"
  | "settled"
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
    successUrl: appUrl(`/sessions?package=${checkout.engagementId}&checkout={CHECKOUT_SESSION_ID}`),
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
    console.error(`[checkout] create failed for ${checkout.engagementId}`, error);
    await releaseCheckout({ ...ids, checkoutSessionId: null });
    throw new PurchaseError(UNAVAILABLE);
  }

  if (await stamp(ids, session.id)) return session.url;
  await stripeGateway()
    .expireCheckout(session.id)
    .catch((error) => console.error(`[checkout] could not expire unstamped ${session.id}`, error));
  return null;
}

async function resumeUrl(checkout: Checkout): Promise<string | null> {
  if (checkout.expiresAt.getTime() - Date.now() < RESUME_MARGIN_MS) return null;
  if (!checkout.stripeCheckoutSessionId) return openCheckout(checkout);
  const session = await stripeGateway().retrieveCheckout(checkout.stripeCheckoutSessionId);
  return session.status === "open" ? session.url : null;
}

/** Where the purchase action sends the student: Stripe's hosted page, or the sessions page once paid. */
export async function checkoutRedirect(
  institutionId: string,
  buy: () => Promise<PurchaseResult>,
): Promise<string> {
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await buy();
      if (result.outcome === "paid") return `/sessions?package=${result.engagementId}`;

      if (result.outcome === "checkout") {
        const url = await resumeUrl(result.checkout);
        if (url) return url;
      }
      const sessionId =
        result.outcome === "checkout"
          ? result.checkout.stripeCheckoutSessionId
          : result.stripeCheckoutSessionId;
      await settleCheckout({ engagementId: result.engagementId, institutionId, sessionId });
    }
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    console.error("[checkout] gateway error", error);
    throw new PurchaseError(UNAVAILABLE);
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

async function refundPayment(ids: Ids, paymentIntentId: string, discrepancyId?: string): Promise<void> {
  const gateway = stripeGateway();
  const previous = (await gateway.listRefunds(paymentIntentId)).find(
    (refund) => refund.status !== "failed" && refund.status !== "canceled",
  );
  const refund = previous ?? (await gateway.refund({ paymentIntentId, ...ids }));
  console.warn(`[checkout] refunded ${paymentIntentId} for ${ids.engagementId}: ${refund.id}`);

  if (!discrepancyId) return;
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

function uniqueViolation(error: unknown, constraint: string): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const pg = cause as Error & { code?: string; constraint_name?: string };
    if (pg.code === "23505" && pg.constraint_name === constraint) return true;
  }
  return false;
}

/** Stripe attaches the balance transaction a few seconds after the charge; the fee is written only at fulfil. */
async function chargeFee(paymentIntentId: string): Promise<NonNullable<ChargeFee>> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(1_500 * attempt);
    const fee = await stripeGateway().chargeFee(paymentIntentId);
    if (fee) return fee;
  }
  throw new GatewayError(`The charge for ${paymentIntentId} has no balance transaction yet.`);
}

async function fulfil(session: CheckoutSession, ids: Ids, paymentIntentId: string): Promise<SyncOutcome> {
  const fee = await chargeFee(paymentIntentId);
  let result: FulfilResult | null = null;
  try {
    result = await fulfilCheckout({
      ...ids,
      checkoutSessionId: session.id,
      payment: {
        paymentIntentId,
        amountTotal: session.amountTotal ?? 0,
        currency: session.currency ?? "",
        chargeFeeMinor: fee.feeMinor,
        balanceTransactionId: fee.balanceTransactionId,
      },
    });
  } catch (error) {
    if (!uniqueViolation(error, "ledger_entry_stripe_reference_idx")) throw error;
    console.error(`[checkout] ${paymentIntentId} is already in the ledger; releasing ${ids.engagementId}`);
    await releaseCheckout({ ...ids, checkoutSessionId: session.id });
  }

  if (result?.outcome === "fulfilled") return "fulfilled";
  if (result?.outcome === "missing") {
    console.warn(`[checkout] ${session.id} names engagement ${ids.engagementId}, which is not here`);
    return "foreign";
  }
  if (await purchaseRecorded(ids, paymentIntentId)) return "settled";
  await refundPayment(
    ids,
    paymentIntentId,
    result?.outcome === "discrepancy" ? result.discrepancyId : undefined,
  );
  return "refunded";
}

async function act(session: CheckoutSession): Promise<SyncOutcome> {
  if (!session.engagementId || !session.institutionId) return "foreign";
  const ids = { engagementId: session.engagementId, institutionId: session.institutionId };

  if (session.status === "complete") {
    if (session.paymentStatus !== "paid" || !session.paymentIntentId) return "unpaid";
    return fulfil(session, ids, session.paymentIntentId);
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
): Promise<{ outcome: SyncOutcome; institutionId: string | null }> {
  const session = await stripeGateway().retrieveCheckout(sessionId);
  return { outcome: await act(session), institutionId: session.institutionId };
}

/** Ends a pending checkout: expire it if open, then act on Stripe's answer. Never releases on an error. */
export async function settleCheckout(row: Ids & { sessionId: string | null }): Promise<SyncOutcome> {
  const gateway = stripeGateway();
  let { sessionId } = row;

  if (!sessionId) {
    const found = await checkoutDetails(db, row);
    if (!found?.checkout || found.status !== "pending_payment") return "settled";
    if (found.checkout.stripeCheckoutSessionId) {
      sessionId = found.checkout.stripeCheckoutSessionId;
    } else {
      let recovered: CheckoutSession;
      try {
        recovered = await gateway.createCheckout(sessionParams(found.checkout));
      } catch (error) {
        console.warn(`[checkout] no Session to recover for ${row.engagementId}; releasing`, error);
        await releaseCheckout({ ...row, checkoutSessionId: null });
        return "released";
      }
      if (!(await stamp(row, recovered.id))) return "settled";
      sessionId = recovered.id;
    }
  }

  let session = await gateway.retrieveCheckout(sessionId);
  if (session.status === "open") {
    try {
      session = await gateway.expireCheckout(sessionId);
    } catch (error) {
      console.warn(`[checkout] expire failed for ${sessionId}; asking Stripe again`, error);
      session = await gateway.retrieveCheckout(sessionId);
    }
  }
  return act(session);
}

export async function syncPendingCheckouts(institutionId: string): Promise<{ settled: number; failed: number }> {
  const rows = await db
    .select({
      engagementId: engagement.id,
      institutionId: engagement.institutionId,
      sessionId: engagement.stripeCheckoutSessionId,
    })
    .from(engagement)
    .where(
      and(
        eq(engagement.institutionId, institutionId),
        eq(engagement.status, "pending_payment"),
        lt(engagement.checkoutExpiresAt, new Date(Date.now() - SWEEP_GRACE_MS)),
      ),
    )
    .orderBy(asc(engagement.checkoutExpiresAt))
    .limit(SWEEP_LIMIT);

  let settled = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await settleCheckout(row);
      settled += 1;
    } catch (error) {
      failed += 1;
      console.error(`[checkout] sweep could not settle ${row.engagementId}`, error);
    }
  }
  return { settled, failed };
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
    const outcome = await syncCheckout(row.sessionId).catch((error) => {
      console.error(`[checkout] could not sync ${row.sessionId}`, error);
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
export async function cancelCheckout(actor: Actor, engagementId: string): Promise<OwnCheckout | null> {
  const [row] = await db
    .select({ sessionId: engagement.stripeCheckoutSessionId, status: engagement.status })
    .from(engagement)
    .where(
      and(
        eq(engagement.id, engagementId),
        eq(engagement.studentProfileId, actor.studentProfileId),
        eq(engagement.institutionId, actor.institutionId),
      ),
    )
    .limit(1);
  if (row?.status === "pending_payment") {
    await settleCheckout({ engagementId, institutionId: actor.institutionId, sessionId: row.sessionId }).catch(
      (error) => console.error(`[checkout] cancel could not settle ${engagementId}`, error),
    );
  }
  return ownCheckout(actor, engagementId);
}
