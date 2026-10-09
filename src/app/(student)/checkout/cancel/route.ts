import type { NextRequest } from "next/server";
import { z } from "zod";

import { cancelCheckout } from "@/server/modules/billing/checkout-session";
import { requireActor } from "@/server/modules/identity/actor";

const packageParam = z.uuid();

export async function GET(request: NextRequest) {
  const actor = await requireActor();
  const parsed = packageParam.safeParse(request.nextUrl.searchParams.get("package"));
  const engagementId = parsed.success ? parsed.data : null;
  const state = engagementId ? await cancelCheckout(actor, engagementId) : null;

  const to =
    state?.status === "active"
      ? `/sessions?package=${engagementId}`
      : state?.kind === "top_up"
        ? "/sessions?cancelled=1"
        : "/requests?cancelled=1";
  return Response.redirect(new URL(to, request.url), 303);
}
