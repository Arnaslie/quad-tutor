import { handleStripeWebhook } from "@/server/modules/billing/webhook";
import { notifySessionChangesSoon } from "@/server/modules/notifications/soon";

export async function POST(request: Request) {
  const payload = await request.text();
  try {
    const result = await handleStripeWebhook(payload, request.headers.get("stripe-signature"));
    if (result.status === 400) return new Response(result.reason, { status: 400 });
    if (result.outcome === "fulfilled" && result.institutionId) {
      notifySessionChangesSoon(result.institutionId);
    }
    return Response.json({ received: true, outcome: result.outcome });
  } catch (error) {
    console.error("[stripe webhook]", error);
    return new Response("Webhook handler failed", { status: 500 });
  }
}
