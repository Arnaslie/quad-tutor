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

const deliveredCount = sql<number>`(
  select count(*)::int from ${sessionBooking}
  where ${sessionBooking.engagementId} = ${engagement.id}
    and ${sessionBooking.status} = 'completed'
)`;

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

/** The whole sweep for one campus. Called by the cron route. */
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
