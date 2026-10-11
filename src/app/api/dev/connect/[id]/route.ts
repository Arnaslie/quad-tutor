import type { NextRequest } from "next/server";

import { fakeStripe, usingFakeStripe } from "@/server/modules/billing/stripe";

function page(accountId: string): Response {
  const link = (outcome: string, label: string) =>
    `<p><a href="?outcome=${outcome}" style="font-size:1.1rem">${label}</a></p>`;
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Fake onboarding</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem">
<h1>Fake Stripe onboarding</h1><p>${accountId}</p>
${link("verified", "Submit and verify")}${link("pending", "Submit, verification pending")}${link("restricted", "Submit, more information needed")}${link("refresh", "Link expired (refresh_url)")}
</body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/dev/connect/[id]">) {
  if (process.env.VERCEL_ENV === "production" || !usingFakeStripe()) {
    return new Response("Not found", { status: 404 });
  }
  const { id } = await ctx.params;
  const link = await fakeStripe.accountLink(id);
  const outcome = request.nextUrl.searchParams.get("outcome");

  if (outcome === "refresh") return Response.redirect(link.refreshUrl, 303);
  if (outcome !== "verified" && outcome !== "pending" && outcome !== "restricted") return page(link.accountId);

  await fakeStripe.setAccount(link.accountId, outcome);
  const { payload, signature } = await fakeStripe.accountEvent(link.accountId);
  const delivered = await fetch(new URL("/api/stripe/webhook", request.url), {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
  });
  if (!delivered.ok) {
    return new Response(`Webhook answered ${delivered.status}: ${await delivered.text()}`, { status: 502 });
  }
  return Response.redirect(link.returnUrl, 303);
}
