import { syncCheckout, type SyncOutcome } from "./checkout-session";
import { stripeGateway, verifyWebhook } from "./stripe";

export type WebhookResult =
  | { status: 400; reason: string }
  | { status: 200; outcome: SyncOutcome | "ignored"; institutionId: string | null };

const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.expired"]);

export async function handleStripeWebhook(payload: string, signature: string | null): Promise<WebhookResult> {
  const event = verifyWebhook(payload, signature);
  if (!event) return { status: 400, reason: "bad signature" };
  if (event.livemode !== stripeGateway().livemode) return { status: 400, reason: "livemode mismatch" };

  if (!CHECKOUT_EVENTS.has(event.type) || !event.objectId) {
    return { status: 200, outcome: "ignored", institutionId: null };
  }
  return { status: 200, ...(await syncCheckout(event.objectId)) };
}
