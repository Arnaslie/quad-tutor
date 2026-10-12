import { syncCheckout, type SyncOutcome } from "./checkout-session";
import { REFUND_EVENTS, handleRefundEvent, type RefundOutcome } from "./refunds";
import { GatewayError, stripeGateway, verifyWebhook } from "./stripe";

export type WebhookResult =
  | { status: 400; reason: string }
  | { status: 200; outcome: SyncOutcome | RefundOutcome | "ignored"; institutionId: string | null };

const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.expired"]);

export async function handleStripeWebhook(payload: string, signature: string | null): Promise<WebhookResult> {
  const event = verifyWebhook(payload, signature);
  if (!event) return { status: 400, reason: "bad signature" };
  if (event.livemode !== stripeGateway().livemode) return { status: 400, reason: "livemode mismatch" };

  if (event.account || !event.objectId) {
    return { status: 200, outcome: "ignored", institutionId: null };
  }
  try {
    if (CHECKOUT_EVENTS.has(event.type)) return { status: 200, ...(await syncCheckout(event.objectId)) };
    if (REFUND_EVENTS.has(event.type)) return { status: 200, ...(await handleRefundEvent(event.type, event.objectId)) };
    return { status: 200, outcome: "ignored", institutionId: null };
  } catch (error) {
    if (error instanceof GatewayError && error.missing) {
      return { status: 200, outcome: "foreign", institutionId: null };
    }
    throw error;
  }
}
