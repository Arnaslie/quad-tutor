import type { NextRequest } from "next/server";

import { fakeStripe, stripeGateway, usingFakeStripe } from "@/server/modules/billing/stripe";

function page(id: string, amount: string): Response {
  const link = (outcome: string, label: string) =>
    `<p><a href="?outcome=${outcome}" style="font-size:1.1rem">${label}</a></p>`;
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Fake checkout</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem">
<h1>Fake Stripe Checkout</h1><p>${id}<br>${amount}</p>
${link("pay", "Pay")}${link("expire", "Let it expire")}${link("cancel", "Back out (cancel_url)")}
</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/dev/checkout/[id]">) {
  if (process.env.VERCEL_ENV === "production" || !usingFakeStripe()) {
    return new Response("Not found", { status: 404 });
  }
  const { id } = await ctx.params;
  const session = await stripeGateway().retrieveCheckout(id);
  const outcome = request.nextUrl.searchParams.get("outcome");

  if (outcome === "cancel" && session.engagementId) {
    return Response.redirect(new URL(`/checkout/cancel?package=${session.engagementId}`, request.url), 303);
  }
  if (outcome !== "pay" && outcome !== "expire") {
    return page(id, `${((session.amountTotal ?? 0) / 100).toFixed(2)} ${session.currency ?? ""}`);
  }

  if (session.status === "open") {
    if (outcome === "pay") await fakeStripe.pay(id);
    else await stripeGateway().expireCheckout(id);
  }
  const { payload, signature } = await fakeStripe.event(id);
  const delivered = await fetch(new URL("/api/stripe/webhook", request.url), {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  if (!delivered.ok) {
    return new Response(`Webhook answered ${delivered.status}: ${await delivered.text()}`, { status: 502 });
  }

  const back = (session.successUrl ?? "/sessions").replace("{CHECKOUT_SESSION_ID}", id);
  return Response.redirect(new URL(back, request.url), 303);
}
