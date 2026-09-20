/**
 * Unused sessions refund at term end.
 *
 * "Breakage income is a trap on a campus where everyone talks"
 * (docs/decisions.md) — the money left in an unfinished package is not
 * revenue, it was never recognised, and keeping it buys a few dollars against
 * the only distribution channel this product has.
 *
 * The refund is deliberately computed as *what is left*, not as
 * `unused x per-session`:
 *
 *     refund = pricePaid - delivered x perSessionMinor
 *
 * which is exactly the deferred balance, so it drives it to zero with no
 * rounding remainder stranded on the books. `perSessionMinor` floors, and a
 * floored rate multiplied by the unused count would quietly keep the
 * difference — which is breakage by another name.
 *
 * There is no job runner in this draft and adding one would be the only
 * scheduled process in the system. What is here is the query and the action;
 * `runTermEndRefunds` is the seam a cron, a Vercel scheduled function or an
 * admin button attaches to. It is safe to re-run: a second pass over an
 * already-closed package finds nothing to do.
 *
 * Known limitation, so the next person does not assume more coverage than
 * exists: this path has been exercised end to end against throwaway fixtures
 * (deferred driven to exactly zero, second sweep a no-op), not against the
 * seeded campus — proving it there would mean back-dating a term other people
 * are building against, which is how a shared seed stops being trustworthy.
 * Before this runs against anything real, exercise it on a term of its own.
 */

import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  sessionBooking,
  studentProfile,
  term,
} from "@/server/db/schema";
import { record } from "@/server/modules/billing/ledger";
import { perSessionMinor } from "@/server/modules/billing/pricing";

import { SessionError } from "./access";

export type TermEndRefund = {
  engagementId: string;
  studentProfileId: string;
  sessionsPurchased: number;
  sessionsDelivered: number;
  refundMinor: number;
  currency: string;
};

/** Delivered sessions, counted the same way everywhere: `completed` bookings. */
const deliveredCount = sql<number>`(
  select count(*)::int from ${sessionBooking}
  where ${sessionBooking.engagementId} = ${engagement.id}
    and ${sessionBooking.status} = 'completed'
)`;

/**
 * Active packages whose term is over. Read-only — safe to show an operator
 * before anything moves.
 */
export async function engagementsDueForTermEndRefund(
  institutionId: string,
): Promise<TermEndRefund[]> {
  const rows = await db
    .select({
      engagementId: engagement.id,
      studentProfileId: engagement.studentProfileId,
      sessionsPurchased: engagement.sessionsPurchased,
      pricePaidMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
      sessionsDelivered: deliveredCount,
    })
    .from(engagement)
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(engagement.status, "active"),
        eq(studentProfile.institutionId, institutionId),
        lt(term.endsOn, sql`current_date`),
      ),
    );

  return rows.map(refundShape).filter((row) => row.refundMinor > 0);
}

function refundShape(row: {
  engagementId: string;
  studentProfileId: string;
  sessionsPurchased: number;
  pricePaidMinor: number;
  currency: string;
  sessionsDelivered: number;
}): TermEndRefund {
  const rate = perSessionMinor(row);
  return {
    engagementId: row.engagementId,
    studentProfileId: row.studentProfileId,
    sessionsPurchased: row.sessionsPurchased,
    sessionsDelivered: row.sessionsDelivered,
    refundMinor: Math.max(0, row.pricePaidMinor - row.sessionsDelivered * rate),
    currency: row.currency,
  };
}

/**
 * Refund one package and close it. Idempotent by the `active` check: a second
 * run finds nothing to do rather than refunding twice.
 */
export async function refundUnusedSessions(
  engagementId: string,
): Promise<TermEndRefund | null> {
  const now = new Date();

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        engagementId: engagement.id,
        studentProfileId: engagement.studentProfileId,
        status: engagement.status,
        sessionsPurchased: engagement.sessionsPurchased,
        pricePaidMinor: engagement.pricePaidMinor,
        currency: engagement.currency,
      })
      .from(engagement)
      .where(eq(engagement.id, engagementId))
      .for("update")
      .limit(1);

    const target = rows.at(0);
    if (!target) throw new SessionError("That package does not exist.");
    if (target.status !== "active") return null;

    // Nothing is going to happen now that the term is over, so anything still
    // on the calendar is unused rather than scheduled. `cancelledAt` and
    // `cancelledByUserId` stay null: no person called these off, the term
    // simply ended, and attributing them to someone would put a cancellation
    // that nobody made in front of the stats job.
    await tx
      .update(sessionBooking)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(sessionBooking.engagementId, engagementId),
          eq(sessionBooking.status, "scheduled"),
        ),
      );

    const delivered = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionBooking)
      .where(
        and(
          eq(sessionBooking.engagementId, engagementId),
          eq(sessionBooking.status, "completed"),
        ),
      );

    const refund = refundShape({
      ...target,
      sessionsDelivered: delivered.at(0)?.n ?? 0,
    });

    if (refund.refundMinor > 0) {
      // TODO(stripe): issue the refund here; `stripeReference` carries the id.
      await record(tx, [
        {
          engagementId,
          type: "refund",
          amountMinor: refund.refundMinor,
          currency: target.currency,
        },
      ]);
    }

    // A package that delivered nothing is `refunded`; one that ran and had
    // sessions left over is `completed` with a refund against it. The ledger
    // carries the money either way — the status is only how it reads to a
    // human.
    await tx
      .update(engagement)
      .set({
        status: refund.sessionsDelivered > 0 ? "completed" : "refunded",
        completedAt: now,
      })
      .where(and(eq(engagement.id, engagementId), eq(engagement.status, "active")));

    return refund;
  });
}

/**
 * The whole sweep for one campus.
 *
 * TODO(scheduling): nothing calls this yet. It is the seam — a cron, a
 * scheduled function, or an operator pressing a button after finals. Whatever
 * calls it must be idempotent-safe, which it is.
 */
export async function runTermEndRefunds(
  institutionId: string,
): Promise<TermEndRefund[]> {
  const due = await engagementsDueForTermEndRefund(institutionId);
  const done: TermEndRefund[] = [];

  for (const candidate of due) {
    const refunded = await refundUnusedSessions(candidate.engagementId);
    if (refunded) done.push(refunded);
  }

  return done;
}
