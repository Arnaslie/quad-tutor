/**
 * The scheduled sweep. One URL, called on a timer by something that stays
 * awake — Vercel Cron in a deployment, `curl` in a loop locally.
 *
 * Why this exists: every deadline in the product was approximate without it.
 * `expireStaleRequests` and `releaseLapsedConfirmations` are called
 * opportunistically by reads, so a request "expired at 12h" only actually
 * expired the next time somebody happened to load a page. On a quiet night
 * that could be hours late, and the tutor whose ranking depends on answering
 * inside the window has no way to know. A timer makes the stated deadlines the
 * real ones.
 *
 * Everything here is safe to run again. The sweeps are idempotent by
 * construction — each one selects rows that are still in the state it acts on,
 * so a second pass in the same minute finds nothing to do. That matters
 * because retries and overlapping schedules are normal, not exceptional.
 *
 * Schedules are UTC and that is deliberate. Every deadline compares
 * `timestamptz` against `now()`, which is an absolute instant, so the zone the
 * scheduler thinks in cannot change an outcome — only when it notices. Campus
 * time (`CAMPUS_TIME_ZONE`) belongs to rendering, not to this.
 */

import { timingSafeEqual } from "node:crypto";

import { db } from "@/server/db";
import { institution } from "@/server/db/schema";
import { releaseLapsedConfirmations } from "@/server/modules/engagements/confirmation";
import { runTermEndRefunds } from "@/server/modules/engagements/termEnd";
import { runNotifications } from "@/server/modules/notifications/dispatch";
import { expireStaleRequests } from "@/server/modules/matching/requests";

/** Sweeps are small, but a term-end pass touches every closed package. */
export const maxDuration = 60;

/**
 * Constant-time compare, because a plain `===` on a secret leaks its length
 * and then its prefix to anyone willing to measure. Cheap to do correctly.
 */
function authorised(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means refuse, never allow. A cron endpoint that opens
  // itself when misconfigured is a cron endpoint anyone can run.
  if (!secret) return false;
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function GET(request: Request) {
  if (!authorised(request.headers.get("authorization"))) {
    // Deliberately says nothing about which part was wrong.
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();

  // Campus-wide sweeps first: they are cheap and they are what the deadlines
  // depend on. Neither takes a tenant key — expiry and auto-release are facts
  // about time, not about a campus.
  await expireStaleRequests();
  const released = await releaseLapsedConfirmations();

  // Per-campus work. One institution today; the loop is what keeps this true
  // on the second campus rather than silently sweeping only the first.
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
}
