import { timingSafeEqual } from "node:crypto";

import { db } from "@/server/db";
import { institution } from "@/server/db/schema";
import { releaseLapsedConfirmations } from "@/server/modules/engagements/confirmation";
import { runTermEndRefunds } from "@/server/modules/engagements/termEnd";
import { runNotifications } from "@/server/modules/notifications/dispatch";
import { expireStaleRequests } from "@/server/modules/matching/requests";

export const maxDuration = 60;

function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;

  if (!secret) return false;
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function GET(request: Request) {
  if (!authorised(request.headers.get("authorization"))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();

  try {

    await expireStaleRequests();
    const released = await releaseLapsedConfirmations();

    const campuses = await db
      .select({ id: institution.id, slug: institution.slug })
      .from(institution);

    let refunded = 0;
    let refundedMinor = 0;
    let notified = 0;

    for (const campus of campuses) {
      const refunds = await runTermEndRefunds(campus.id);
      refunded += refunds.length;
      refundedMinor += refunds.reduce((sum, refund) => sum + refund.refundMinor, 0);
      notified += await runNotifications(campus.id);
    }

    return Response.json({
      ok: true,
      released,
      refunded,
      refundedMinor,
      notified,
      campuses: campuses.length,
      tookMs: Date.now() - startedAt,
    });
  } catch (error) {
    // The caller proved it holds CRON_SECRET, so the reason is safe to return
    // here and saves a trip to the platform logs.
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron]", error);
    return Response.json(
      { ok: false, error: message, tookMs: Date.now() - startedAt },
      { status: 500 },
    );
  }
}
