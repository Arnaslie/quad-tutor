import type { TutorActor } from "@/server/modules/identity/actor";

import { payoutsOf, type Payouts } from "./connect";
import { GatewayError, errorFacts, stripeGateway } from "./stripe";

export type CashOutOffer = { grossMinor: number; netMinor: number; feeMinor: number; currency: string };

export type CashOutResult =
  | { status: "sent"; netMinor: number; currency: string }
  | { status: "changed" }
  | { status: "busy" }
  | { status: "retry" }
  | { status: "refused" }
  | { status: "unavailable" };

/** Leaves out the destination, so the offer can cross to the client. Null hides the button. */
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

export async function cashOut(
  actor: TutorActor,
  confirmed: { netMinor: number; requestId: string },
): Promise<CashOutResult> {
  const { accountId, status } = await payoutsOf(actor);
  if (!accountId || status !== "verified") return { status: "unavailable" };
  const gateway = stripeGateway();
  try {
    const balance = await gateway.instantBalance(accountId);
    if (!balance) return { status: "unavailable" };
    if (balance.netMinor !== confirmed.netMinor) return { status: "changed" };
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
    console.error("[cash-out] instant payout failed", errorFacts(error));
    if (error.inFlight) return { status: "busy" };
    if (error.idempotency) return { status: "changed" };
    // Stripe replays a saved 5xx for the same key, so only an unanswered or rate-limited call keeps it.
    return error.status === undefined || error.status === 429 ? { status: "retry" } : { status: "refused" };
  }
}
