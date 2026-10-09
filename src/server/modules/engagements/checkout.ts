import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, moneyDiscrepancy, sessionBooking } from "@/server/db/schema";
import { record, type LedgerWrite } from "@/server/modules/billing/ledger";

import type { Executor } from "./access";

export type CheckoutPayment = {
  paymentIntentId: string;
  amountTotal: number;
  currency: string;
  chargeFeeMinor?: number;
  balanceTransactionId?: string;
};

type EngagementStatus = (typeof engagement.$inferSelect)["status"];

type Settled =
  | { outcome: "missing" }
  | { outcome: "other_session" }
  | { outcome: "not_pending"; status: EngagementStatus };

export type FulfilResult =
  | Settled
  | { outcome: "fulfilled" }
  | {
      outcome: "discrepancy";
      discrepancyId: string;
      expectedMinor: number;
      expectedCurrency: string;
      paidMinor: number;
      paidCurrency: string;
    };

export type ReleaseResult = Settled | { outcome: "released" };

type Ids = { engagementId: string; institutionId: string };

async function lockEngagement(tx: Executor, params: Ids) {
  const rows = await tx
    .select({
      status: engagement.status,
      pricePaidMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
      checkoutSessionId: engagement.stripeCheckoutSessionId,
    })
    .from(engagement)
    .where(
      and(
        eq(engagement.id, params.engagementId),
        eq(engagement.institutionId, params.institutionId),
      ),
    )
    .for("update")
    .limit(1);
  return rows.at(0);
}

async function close(
  tx: Executor,
  params: Ids,
  to: { engagement: "active" | "cancelled"; sessions: Partial<typeof sessionBooking.$inferInsert> },
  checkoutSessionId?: string,
): Promise<void> {
  await tx
    .update(engagement)
    .set({ status: to.engagement, stripeCheckoutSessionId: checkoutSessionId })
    .where(eq(engagement.id, params.engagementId));
  await tx
    .update(sessionBooking)
    .set(to.sessions)
    .where(
      and(
        eq(sessionBooking.engagementId, params.engagementId),
        eq(sessionBooking.institutionId, params.institutionId),
        eq(sessionBooking.status, "held"),
      ),
    );
}

const released = () =>
  ({ engagement: "cancelled", sessions: { status: "cancelled", cancelledAt: new Date() } }) as const;

async function amountDiscrepancy(tx: Executor, params: Ids, paymentIntentId: string) {
  const rows = await tx
    .select({
      id: moneyDiscrepancy.id,
      ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor,
      stripeAmountMinor: moneyDiscrepancy.stripeAmountMinor,
      currency: moneyDiscrepancy.currency,
    })
    .from(moneyDiscrepancy)
    .where(
      and(
        eq(moneyDiscrepancy.engagementId, params.engagementId),
        eq(moneyDiscrepancy.institutionId, params.institutionId),
        eq(moneyDiscrepancy.kind, "checkout_amount"),
        eq(moneyDiscrepancy.stripeReference, paymentIntentId),
      ),
    )
    .limit(1);
  return rows.at(0);
}

/** Never paid on a mismatch: the checkout is cancelled and a discrepancy recorded for the refund. */
export async function fulfilCheckout(params: {
  engagementId: string;
  institutionId: string;
  checkoutSessionId: string;
  payment: CheckoutPayment;
}): Promise<FulfilResult> {
  const { payment } = params;

  return db.transaction(async (tx) => {
    const target = await lockEngagement(tx, params);
    if (!target) return { outcome: "missing" };

    const expected = { expectedMinor: target.pricePaidMinor, expectedCurrency: target.currency };

    if (target.status !== "pending_payment") {
      const recorded = await amountDiscrepancy(tx, params, payment.paymentIntentId);
      if (recorded) {
        return {
          outcome: "discrepancy",
          discrepancyId: recorded.id,
          ...expected,
          paidMinor: recorded.stripeAmountMinor ?? payment.amountTotal,
          paidCurrency: recorded.currency,
        };
      }
      return { outcome: "not_pending", status: target.status };
    }
    if (target.checkoutSessionId !== null && target.checkoutSessionId !== params.checkoutSessionId) {
      return { outcome: "other_session" };
    }

    const paidCurrency = payment.currency.toLowerCase();
    if (payment.amountTotal !== target.pricePaidMinor || paidCurrency !== target.currency) {
      await close(tx, params, released(), params.checkoutSessionId);
      const [discrepancy] = await tx
        .insert(moneyDiscrepancy)
        .values({
          institutionId: params.institutionId,
          engagementId: params.engagementId,
          kind: "checkout_amount",
          stripeReference: payment.paymentIntentId,
          ledgerAmountMinor: target.pricePaidMinor,
          stripeAmountMinor: payment.amountTotal,
          currency: paidCurrency,
        })
        .returning({ id: moneyDiscrepancy.id });
      return {
        outcome: "discrepancy",
        discrepancyId: discrepancy.id,
        ...expected,
        paidMinor: payment.amountTotal,
        paidCurrency,
      };
    }

    await close(
      tx,
      params,
      { engagement: "active", sessions: { status: "scheduled" } },
      params.checkoutSessionId,
    );

    const entries: LedgerWrite[] = [
      {
        engagementId: params.engagementId,
        institutionId: params.institutionId,
        type: "package_purchase",
        amountMinor: target.pricePaidMinor,
        currency: target.currency,
        stripeReference: payment.paymentIntentId,
      },
    ];
    if (payment.chargeFeeMinor !== undefined) {
      entries.push({
        engagementId: params.engagementId,
        institutionId: params.institutionId,
        type: "processor_fee",
        amountMinor: payment.chargeFeeMinor,
        currency: target.currency,
        stripeReference: payment.balanceTransactionId ?? null,
      });
    }
    await record(tx, entries);

    return { outcome: "fulfilled" };
  });
}

/** Only once Stripe says the Checkout Session is dead; a payment must never land on a released slot. */
export async function releaseCheckout(params: {
  engagementId: string;
  institutionId: string;
  checkoutSessionId: string | null;
}): Promise<ReleaseResult> {
  return db.transaction(async (tx) => {
    const target = await lockEngagement(tx, params);
    if (!target) return { outcome: "missing" };
    if (target.status !== "pending_payment") {
      return { outcome: "not_pending", status: target.status };
    }
    if (target.checkoutSessionId !== params.checkoutSessionId) return { outcome: "other_session" };

    await close(tx, params, released());
    return { outcome: "released" };
  });
}
