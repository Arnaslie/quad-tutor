import { timingSafeEqual } from "node:crypto";

import { db } from "@/server/db";
import { institution } from "@/server/db/schema";
import { syncPendingCheckouts } from "@/server/modules/billing/checkout-session";
import { SWEEP_BUDGET_MS, retryUnstampedRefunds } from "@/server/modules/billing/refunds";
import { errorFacts } from "@/server/modules/billing/stripe";
import { runTransfers, type TransferCounts } from "@/server/modules/billing/transfers";
import { releaseLapsedConfirmations } from "@/server/modules/engagements/confirmation";
import { runTermEndRefunds } from "@/server/modules/engagements/termEnd";
import { runNotifications } from "@/server/modules/notifications/dispatch";
import { expireStaleRequests } from "@/server/modules/matching/requests";
import { releaseRatings } from "@/server/modules/ratings/release";
import { refreshScores } from "@/server/modules/scoring/stats";
import { purgeProofFiles } from "@/server/modules/tutoring/verification";

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
    let refundsHeld = 0;
    let refundsFailed = 0;
    let notified = 0;
    let purgedProofs = 0;
    let releasedRatings = 0;
    let refreshedScores = 0;
    let checkoutsSettled = 0;
    let checkoutsFailed = 0;
    let cardRefundsSettled = 0;
    let cardRefundsFlagged = 0;
    let cardRefundsBlocked = 0;
    let cardRefundsFailed = 0;
    const transfers: TransferCounts = { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 0, failed: 0 };

    for (const campus of campuses) {
      releasedRatings += await releaseRatings(campus.id).catch((error) => {
        console.error(`[cron] rating release for ${campus.slug} failed`, error);
        return 0;
      });
      purgedProofs += await purgeProofFiles(campus.id).catch((error) => {
        console.error(`[cron] proof purge for ${campus.slug} failed`, error);
        return 0;
      });
      const { refunds, held, failed } = await runTermEndRefunds(campus.id, startedAt + SWEEP_BUDGET_MS).catch((error) => {
        console.error(`[cron] term-end refunds for ${campus.slug} failed`, error);
        return { refunds: [], held: 0, failed: 1 };
      });
      refundsHeld += held;
      refundsFailed += failed;
      refunded += refunds.length;
      refundedMinor += refunds.reduce((sum, refund) => sum + refund.refundMinor, 0);
      const checkouts = await syncPendingCheckouts(campus.id, startedAt + SWEEP_BUDGET_MS).catch((error) => {
        console.error(`[cron] checkout sweep for ${campus.slug} failed`, errorFacts(error));
        return { settled: 0, failed: 1 };
      });
      checkoutsSettled += checkouts.settled;
      checkoutsFailed += checkouts.failed;
      const cardRefunds = await retryUnstampedRefunds(campus.id, startedAt + SWEEP_BUDGET_MS).catch((error) => {
        console.error(`[cron] card refund retries for ${campus.slug} failed`, errorFacts(error));
        return { settled: 0, flagged: 0, blocked: 0, failed: 1 };
      });
      cardRefundsSettled += cardRefunds.settled;
      cardRefundsFlagged += cardRefunds.flagged;
      cardRefundsBlocked += cardRefunds.blocked;
      cardRefundsFailed += cardRefunds.failed;
      const campusTransfers = await runTransfers(campus.id, startedAt + SWEEP_BUDGET_MS).catch((error) => {
        console.error(`[cron] tutor transfers for ${campus.slug} failed`, errorFacts(error));
        return { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 0, failed: 1 };
      });
      for (const key of Object.keys(transfers) as (keyof TransferCounts)[]) transfers[key] += campusTransfers[key];
      notified += await runNotifications(campus.id);
      refreshedScores += await refreshScores(campus.id).catch((error) => {
        console.error(`[cron] score refresh for ${campus.slug} failed`, error);
        return 0;
      });
    }

    return Response.json({
      ok: true,
      released,
      refunded,
      refundedMinor,
      refundsHeld,
      refundsFailed,
      notified,
      purgedProofs,
      releasedRatings,
      refreshedScores,
      checkoutsSettled,
      checkoutsFailed,
      cardRefundsSettled,
      cardRefundsFlagged,
      cardRefundsBlocked,
      cardRefundsFailed,
      transfersSent: transfers.sent,
      transfersSettled: transfers.settled,
      transfersWaiting: transfers.waiting,
      transfersFlagged: transfers.flagged,
      transfersBlocked: transfers.blocked,
      transfersFailed: transfers.failed,
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
