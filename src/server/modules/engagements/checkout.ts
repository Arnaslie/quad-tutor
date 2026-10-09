import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, sessionBooking } from "@/server/db/schema";
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

export type FulfilResult =
  | { outcome: "fulfilled" }
  | { outcome: "missing" }
  | { outcome: "not_pending"; status: EngagementStatus }
  | {
      outcome: "discrepancy";
      expectedMinor: number;
      expectedCurrency: string;
      paidMinor: number;
      paidCurrency: string;
    };

export type ReleaseResult =
  | { outcome: "released" }
  | { outcome: "missing" }
  | { outcome: "not_pending"; status: EngagementStatus };

async function lockEngagement(
  tx: Executor,
  params: { engagementId: string; institutionId: string },
) {
  const rows = await tx
    .select({
      status: engagement.status,
      pricePaidMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
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

async function moveHeld(
  tx: Executor,
  params: { engagementId: string; institutionId: string },
  to: Partial<typeof sessionBooking.$inferInsert>,
): Promise<void> {
  await tx
    .update(sessionBooking)
    .set(to)
    .where(
      and(
        eq(sessionBooking.engagementId, params.engagementId),
        eq(sessionBooking.institutionId, params.institutionId),
        eq(sessionBooking.status, "held"),
      ),
    );
}

export async function fulfilCheckout(params: {
  engagementId: string;
  institutionId: string;
  payment: CheckoutPayment;
}): Promise<FulfilResult> {
  const { payment } = params;

  return db.transaction(async (tx) => {
    const target = await lockEngagement(tx, params);
    if (!target) return { outcome: "missing" };
    if (target.status !== "pending_payment") {
      return { outcome: "not_pending", status: target.status };
    }

    const paidCurrency = payment.currency.toLowerCase();
    if (payment.amountTotal !== target.pricePaidMinor || paidCurrency !== target.currency) {
      return {
        outcome: "discrepancy",
        expectedMinor: target.pricePaidMinor,
        expectedCurrency: target.currency,
        paidMinor: payment.amountTotal,
        paidCurrency,
      };
    }

    await tx
      .update(engagement)
      .set({ status: "active" })
      .where(eq(engagement.id, params.engagementId));
    await moveHeld(tx, params, { status: "scheduled" });

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
}): Promise<ReleaseResult> {
  return db.transaction(async (tx) => {
    const target = await lockEngagement(tx, params);
    if (!target) return { outcome: "missing" };
    if (target.status !== "pending_payment") {
      return { outcome: "not_pending", status: target.status };
    }

    await tx
      .update(engagement)
      .set({ status: "cancelled" })
      .where(eq(engagement.id, params.engagementId));
    await moveHeld(tx, params, { status: "cancelled", cancelledAt: new Date() });

    return { outcome: "released" };
  });
}
