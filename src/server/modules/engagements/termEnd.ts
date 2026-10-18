import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { formatDayTime } from "@/components/format";
import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  sessionBooking,
  term,
} from "@/server/db/schema";
import { deferredMinor, record } from "@/server/modules/billing/ledger";
import { SWEEP_BUDGET_MS, refundThroughStripe } from "@/server/modules/billing/refunds";
import { errorFacts } from "@/server/modules/billing/stripe";
import type { Actor } from "@/server/modules/identity/actor";

import { SessionError, deliveredCount } from "./access";
import { END_BLOCK_MESSAGE, endBlock, type EndBlock } from "./attendance";

export type TermEndRefund = {
  engagementId: string;
  studentProfileId: string;
  sessionsPurchased: number;
  sessionsDelivered: number;
  refundMinor: number;
  currency: string;
};

const refundFields = () => ({
  engagementId: engagement.id,
  studentProfileId: engagement.studentProfileId,
  sessionsPurchased: engagement.sessionsPurchased,
  sessionsDelivered: deliveredCount(engagement.id, engagement.institutionId),
  refundMinor: deferredMinor(engagement.id, engagement.institutionId),
  currency: engagement.currency,
});

export async function engagementsDueForTermEndRefund(
  institutionId: string,
): Promise<TermEndRefund[]> {
  const rows = await db
    .select(refundFields())
    .from(engagement)
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(engagement.status, "active"),
        eq(engagement.institutionId, institutionId),
        lt(term.endsOn, sql`current_date`),
      ),
    );

  return rows.filter((row) => row.refundMinor > 0);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class EndPackageError extends SessionError {
  constructor(readonly block: EndBlock) {
    super(END_BLOCK_MESSAGE[block.reason](formatDayTime(block.scheduledAt)));
  }
}

export async function closeWithRefund(
  tx: Tx,
  params: { engagementId: string; institutionId: string; endedBy?: Actor },
): Promise<TermEndRefund | null> {
  const { engagementId, endedBy } = params;
  const now = new Date();

  const rows = await tx
    .select({ studentProfileId: engagement.studentProfileId, status: engagement.status })
    .from(engagement)
    .where(
      and(eq(engagement.id, engagementId), eq(engagement.institutionId, params.institutionId)),
    )
    .for("update")
    .limit(1);

  const target = rows.at(0);
  if (!target) throw new SessionError("That package does not exist.");
  if (endedBy && target.studentProfileId !== endedBy.studentProfileId) {
    throw new SessionError("That package is not yours.");
  }
  if (target.status !== "active") return null;

  const sessions = await tx
    .select({ status: sessionBooking.status, scheduledAt: sessionBooking.scheduledAt })
    .from(sessionBooking)
    .where(
      and(
        eq(sessionBooking.engagementId, engagementId),
        eq(sessionBooking.institutionId, params.institutionId),
        inArray(sessionBooking.status, ["scheduled", "disputed"]),
      ),
    );
  const block = endBlock(sessions, now);
  if (block && (endedBy || block.reason !== "late_cancel_window")) {
    throw new EndPackageError(block);
  }

  await tx
    .update(sessionBooking)
    .set(
      endedBy
        ? { status: "cancelled", cancelledAt: now, cancelledByUserId: endedBy.userId }
        : { status: "cancelled" },
    )
    .where(
      and(
        eq(sessionBooking.engagementId, engagementId),
        eq(sessionBooking.institutionId, params.institutionId),
        eq(sessionBooking.status, "scheduled"),
      ),
    );

  const [refund] = await tx
    .select(refundFields())
    .from(engagement)
    .where(eq(engagement.id, engagementId));

  if (refund.refundMinor > 0) {
    await record(tx, [
      {
        engagementId,
        institutionId: params.institutionId,
        type: "refund",
        amountMinor: refund.refundMinor,
        currency: refund.currency,
      },
    ]);
  }

  await tx
    .update(engagement)
    .set({
      status: refund.sessionsDelivered > 0 ? "completed" : "refunded",
      completedAt: now,
    })
    .where(and(eq(engagement.id, engagementId), eq(engagement.status, "active")));

  return refund;
}

export async function endPackage(params: {
  actor: Actor;
  engagementId: string;
}): Promise<TermEndRefund | null> {
  return db.transaction((tx) =>
    closeWithRefund(tx, {
      engagementId: params.engagementId,
      institutionId: params.actor.institutionId,
      endedBy: params.actor,
    }),
  );
}

export type TermEndSweep = { refunds: TermEndRefund[]; held: number; failed: number };

/** The whole sweep for one campus. Called by the cron route. */
export async function runTermEndRefunds(
  institutionId: string,
  deadline = Date.now() + SWEEP_BUDGET_MS,
): Promise<TermEndSweep> {
  const due = await engagementsDueForTermEndRefund(institutionId);
  const refunds: TermEndRefund[] = [];
  let held = 0;
  let failed = 0;

  for (const candidate of due) {
    try {
      const refunded = await db.transaction((tx) =>
        closeWithRefund(tx, { engagementId: candidate.engagementId, institutionId }),
      );
      if (refunded) refunds.push(refunded);
      if (refunded && Date.now() < deadline) {
        await refundThroughStripe({ engagementId: candidate.engagementId, institutionId }).catch((error) =>
          console.error(`[term-end] card refund for ${candidate.engagementId} left for the retry sweep`, errorFacts(error)),
        );
      }
    } catch (error) {
      if (error instanceof EndPackageError) {
        held += 1;
        console.warn(`[term-end] ${candidate.engagementId} held (${error.block.reason})`);
      } else {
        failed += 1;
        console.error(`[term-end] ${candidate.engagementId} failed`, error);
      }
    }
  }

  return { refunds, held, failed };
}
