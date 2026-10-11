import { syncCheckout, type SyncOutcome } from "./checkout-session";
import { syncConnectAccount, type ConnectOutcome } from "./connect";
import { GatewayError, stripeGateway, verifyWebhook } from "./stripe";

export type WebhookResult =
  | { status: 400; reason: string }
  | { status: 200; outcome: SyncOutcome | ConnectOutcome | "ignored"; institutionId: string | null };

const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.expired"]);

export async function handleStripeWebhook(payload: string, signature: string | null): Promise<WebhookResult> {
  const event = verifyWebhook(payload, signature);
  if (!event) return { status: 400, reason: "bad signature" };
  if (event.livemode !== stripeGateway().livemode) return { status: 400, reason: "livemode mismatch" };

  if (event.type === "account.updated") {
    const accountId = event.account ?? event.objectId;
    if (!accountId) return { status: 200, outcome: "ignored", institutionId: null };
    try {
      return { status: 200, ...(await syncConnectAccount(accountId)) };
    } catch (error) {
      if (error instanceof GatewayError && error.missing) {
        return { status: 200, outcome: "foreign", institutionId: null };
      }
      throw error;
    }
  }

  if (event.account || !CHECKOUT_EVENTS.has(event.type) || !event.objectId) {
    return { status: 200, outcome: "ignored", institutionId: null };
  }
  try {
    return { status: 200, ...(await syncCheckout(event.objectId)) };
  } catch (error) {
    if (error instanceof GatewayError && error.missing) {
      return { status: 200, outcome: "foreign", institutionId: null };
    }
    throw error;
  }
}
