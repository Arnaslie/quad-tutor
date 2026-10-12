import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { ledgerEntry, paymentDispute } from "@/server/db/schema";

import { stripeGateway } from "./stripe";

export const DISPUTE_EVENTS = new Set([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]);

const CLOSED = new Set(["won", "lost", "warning_closed", "prevented"]);

export type DisputeOutcome = "dispute_recorded" | "foreign";

/**
 * Records the chargeback against the engagement its PaymentIntent bought, which pauses that engagement's
 * transfers. Stripe closing it is recorded too, but only ops resolving it lifts the pause.
 */
export async function handleDisputeEvent(
  disputeId: string,
): Promise<{ outcome: DisputeOutcome; institutionId: string | null }> {
  const dispute = await stripeGateway().retrieveDispute(disputeId);
  const [bought] = dispute.paymentIntentId
    ? await db
        .select({ engagementId: ledgerEntry.engagementId, institutionId: ledgerEntry.institutionId })
        .from(ledgerEntry)
        .where(and(eq(ledgerEntry.type, "package_purchase"), eq(ledgerEntry.stripeReference, dispute.paymentIntentId)))
    : [];
  if (!bought || !dispute.paymentIntentId) {
    console.error(`[dispute] ${dispute.id} on ${dispute.paymentIntentId ?? dispute.chargeId} matches no package; check it by hand`);
    return { outcome: "foreign", institutionId: null };
  }

  const [row] = await db
    .insert(paymentDispute)
    .values({
      ...bought,
      stripeDisputeId: dispute.id,
      paymentIntentId: dispute.paymentIntentId,
      amountMinor: dispute.amountMinor,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      openedAt: dispute.createdAt,
      closedAt: CLOSED.has(dispute.status) ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: paymentDispute.stripeDisputeId,
      set: {
        status: dispute.status,
        reason: dispute.reason,
        amountMinor: dispute.amountMinor,
        closedAt: sql`coalesce(${paymentDispute.closedAt}, excluded.closed_at)`,
      },
      setWhere: eq(paymentDispute.institutionId, bought.institutionId),
    })
    .returning({ created: sql<boolean>`xmax = 0` });
  if (row?.created) {
    console.error(
      `[dispute] ${dispute.id} opened on engagement ${bought.engagementId} (${dispute.reason}, ${dispute.amountMinor} ${dispute.currency}); its transfers are paused until ops resolves it`,
    );
  }
  return { outcome: "dispute_recorded", institutionId: bought.institutionId };
}
