import type { TutorActor } from "@/server/modules/identity/actor";

import { payoutsOf, type Payouts } from "./connect";
import { GatewayError, errorFacts, stripeGateway } from "./stripe";

export type CashOutOffer = { grossMinor: number; netMinor: number; feeMinor: number; currency: string };

export type CashOutResult =
  | { status: "sent"; netMinor: number; currency: string }
  | { status: "changed" }
  | { status: "busy" }
  | { status: "unavailable" };

/** Stripe's quote for cashing out now, without the destination, so it can cross to the client. Null hides the button. */
export async function cashOutOffer(payouts: Pick<Payouts, "accountId" | "status">): Promise<CashOutOffer | null> {
  if (!payouts.accountId || payouts.status !== "verified") return null;
  try {
    const balance = await stripeGateway().instantBalance(payouts.accountId);
    if (!balance) return null;
    const { grossMinor, netMinor, currency } = balance;
    return { grossMinor, netMinor, feeMinor: grossMinor - netMinor, currency };
  } catch (error) {
    console.error("[cash-out] instant balance read failed", errorFacts(error));
    return null;
  }
}

/**
 * Sends the whole instant balance to the tutor's card at Stripe's quote, only if the quote is still the one the
 * tutor confirmed. Moves connected-balance money to a bank, so no ledger row is written.
 */
export async function cashOut(
  actor: TutorActor,
  confirmed: { netMinor: number; requestId: string },
): Promise<CashOutResult> {
  const { accountId, status } = await payoutsOf(actor);
  if (!accountId || status !== "verified") return { status: "unavailable" };
  const gateway = stripeGateway();
  const balance = await gateway.instantBalance(accountId);
  if (!balance) return { status: "unavailable" };
  if (balance.netMinor !== confirmed.netMinor) return { status: "changed" };
  try {
    const payout = await gateway.createInstantPayout({
      accountId,
      amountMinor: balance.netMinor,
      currency: balance.currency,
      destination: balance.destination,
      tutorProfileId: actor.tutorProfileId,
      institutionId: actor.institutionId,
      idempotencyKey: `instant-payout:${accountId}:${confirmed.requestId}`,
    });
    return { status: "sent", netMinor: payout.amountMinor, currency: payout.currency };
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.inFlight) return { status: "busy" };
    if (!error.refused && !error.idempotency) throw error;
    console.error("[cash-out] instant payout refused", errorFacts(error));
    return { status: "unavailable" };
  }
}
