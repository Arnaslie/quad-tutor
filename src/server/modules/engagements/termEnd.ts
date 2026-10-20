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

import { SessionError, deliveredCount, heldAgainstPackage, loadParticipation, lockSession } from "./access";
import { END_BLOCK_MESSAGE, endBlock, type EndBlock } from "./attendance";
import { chargeCancel, type CancelCharge } from "./cancel-charge";
import { endFeeMinor, hoursBefore, keptShareBp } from "./cancel-rules";

export type TermEndRefund = {
  engagementId: string;
  /** The refund row closing wrote, for the card refund after commit; null when nothing was left to refund. */
  refundId: string | null;
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
): Promise<Omit<TermEndRefund, "refundId">[]> {
  // Every package still open, refund or not: one that cancels used up and whose close after commit failed owes nothing.
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

  return rows;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class EndPackageError extends SessionError {
  constructor(readonly block: EndBlock) {
    super(END_BLOCK_MESSAGE[block.reason](formatDayTime(block.scheduledAt)));
  }
}

type EngagementLock = "update" | "no key update";

/** A package the student ended also carries what the tutor kept: the end fee, and each session charged at its tier. */
export type EndedPackage = TermEndRefund & { feeMinor: number; charged: CancelCharge[] };

export async function closeWithRefund(
  tx: Tx,
  params: { engagementId: string; institutionId: string; endedBy?: Actor; lock?: EngagementLock },
): Promise<EndedPackage | null> {
  const { engagementId, endedBy } = params;
  const now = new Date();

  const rows = await tx
    .select({ studentProfileId: engagement.studentProfileId, status: engagement.status })
    .from(engagement)
    .where(
      and(eq(engagement.id, engagementId), eq(engagement.institutionId, params.institutionId)),
    )
    .for(params.lock ?? "update")
    .limit(1);

  const target = rows.at(0);
  if (!target) throw new SessionError("That package does not exist.");
  if (endedBy && target.studentProfileId !== endedBy.studentProfileId) {
    throw new SessionError("That package is not yours.");
  }
  if (target.status !== "active") return null;

  const sessions = await tx
    .select({ id: sessionBooking.id, status: sessionBooking.status, scheduledAt: sessionBooking.scheduledAt })
    .from(sessionBooking)
    .where(
      and(
        eq(sessionBooking.engagementId, engagementId),
        eq(sessionBooking.institutionId, params.institutionId),
        inArray(sessionBooking.status, ["scheduled", "disputed"]),
      ),
    );
  const block = endBlock(sessions, now);
  if (block) throw new EndPackageError(block);

  const charged: CancelCharge[] = [];
  if (endedBy) {
    const priced = sessions.filter(
      (session) => session.status === "scheduled" && keptShareBp(hoursBefore(session.scheduledAt, now), "student") > 0,
    );
    for (const { id } of priced) {
      await lockSession(tx, id);
      const session = await loadParticipation({ exec: tx, sessionId: id, actor: endedBy });
      charged.push(await chargeCancel(tx, session, endedBy.userId, now));
    }
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

  const [due] = await tx
    .select(refundFields())
    .from(engagement)
    .where(and(eq(engagement.id, engagementId), eq(engagement.institutionId, params.institutionId)));

  // The tutor's pay, not the platform's: no platform_fee row, so the fee meter never sees it.
  const feeMinor = endedBy ? endFeeMinor(due.refundMinor) : 0;
  const entry = { engagementId, institutionId: params.institutionId, currency: due.currency };
  if (feeMinor > 0) {
    await record(tx, [
      { ...entry, type: "session_earned", amountMinor: feeMinor },
      { ...entry, type: "tutor_accrued", amountMinor: feeMinor },
    ]);
  }
  const refundMinor = due.refundMinor - feeMinor;
  const [written] = refundMinor > 0 ? await record(tx, [{ ...entry, type: "refund", amountMinor: refundMinor }]) : [];
  const refund = { ...due, refundMinor, refundId: written?.id ?? null, feeMinor, charged };

  await tx
    .update(engagement)
    .set({
      status: refund.sessionsDelivered > 0 ? "completed" : "refunded",
      completedAt: now,
    })
    .where(and(eq(engagement.id, engagementId), eq(engagement.status, "active")));

  return refund;
}

/** Closes a package once every session in it was delivered or kept by a cancel, refunding what is left. */
export async function closeIfUsedUp(
  tx: Tx,
  ids: { engagementId: string; institutionId: string },
  lock: EngagementLock = "update",
): Promise<TermEndRefund | null> {
  const [target] = await tx
    .select({ status: engagement.status, sessionsPurchased: engagement.sessionsPurchased })
    .from(engagement)
    .where(and(eq(engagement.id, ids.engagementId), eq(engagement.institutionId, ids.institutionId)));
  if (target?.status !== "active") return null;

  const [{ used }] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(sessionBooking)
    .where(
      and(
        eq(sessionBooking.engagementId, ids.engagementId),
        eq(sessionBooking.institutionId, ids.institutionId),
        inArray(sessionBooking.status, ["completed", "cancelled"]),
        heldAgainstPackage(),
      ),
    );
  if (used < target.sessionsPurchased) return null;

  return closeWithRefund(tx, { ...ids, lock });
}

export type EndQuote = { backMinor: number; tutorMinor: number };

export function endQuote(ended: EndedPackage): EndQuote {
  const sum = (pick: (charge: CancelCharge) => number) => ended.charged.reduce((total, charge) => total + pick(charge), 0);
  return {
    backMinor: ended.refundMinor + sum((charge) => charge.returnedMinor),
    tutorMinor: ended.feeMinor + sum((charge) => charge.keptMinor),
  };
}

/** What ending gives back differs from what the student was shown. Nothing was ended. */
export class EndQuoteChanged extends SessionError {
  constructor(readonly quote: EndQuote) {
    super("What ending gives back changed since you opened this. Nothing was ended. Check the new amount and end again.");
  }
}

export async function endPackage(params: {
  actor: Actor;
  engagementId: string;
  /** What the end form said goes back to the card. A different amount rolls the end back. */
  shownBackMinor?: number;
}): Promise<EndedPackage | null> {
  return db.transaction(async (tx) => {
    const ended = await closeWithRefund(tx, {
      engagementId: params.engagementId,
      institutionId: params.actor.institutionId,
      endedBy: params.actor,
    });
    if (ended && params.shownBackMinor !== undefined && endQuote(ended).backMinor !== params.shownBackMinor) {
      throw new EndQuoteChanged(endQuote(ended));
    }
    return ended;
  });
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
      if (refunded && refunded.refundMinor > 0) refunds.push(refunded);
      if (refunded?.refundId && Date.now() < deadline) {
        await refundThroughStripe({ id: refunded.refundId, engagementId: candidate.engagementId, institutionId }).catch((error) =>
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
