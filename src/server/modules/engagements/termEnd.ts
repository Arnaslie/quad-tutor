import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { formatDayTime } from "@/components/format";
import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  sessionBooking,
  studentProfile,
  term,
} from "@/server/db/schema";
import { record } from "@/server/modules/billing/ledger";
import { unusedRefundMinor } from "@/server/modules/billing/pricing";
import type { Actor } from "@/server/modules/identity/actor";

import { SessionError } from "./access";
import { END_BLOCK_MESSAGE, endBlock, type EndBlock } from "./attendance";

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
  return {
    engagementId: row.engagementId,
    studentProfileId: row.studentProfileId,
    sessionsPurchased: row.sessionsPurchased,
    sessionsDelivered: row.sessionsDelivered,
    refundMinor: unusedRefundMinor(row),
    currency: row.currency,
  };
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
    .select({
      engagementId: engagement.id,
      studentProfileId: engagement.studentProfileId,
      status: engagement.status,
      sessionsPurchased: engagement.sessionsPurchased,
      pricePaidMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
    })
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

  if (endedBy) {
    const sessions = await tx
      .select({ status: sessionBooking.status, scheduledAt: sessionBooking.scheduledAt })
      .from(sessionBooking)
      .where(
        and(
          eq(sessionBooking.engagementId, engagementId),
          inArray(sessionBooking.status, ["scheduled", "disputed"]),
        ),
      );
    const block = endBlock(sessions, now);
    if (block) throw new EndPackageError(block);
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
        institutionId: params.institutionId,
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

/** The whole sweep for one campus. Called by the cron route. */
export async function runTermEndRefunds(
  institutionId: string,
): Promise<TermEndRefund[]> {
  const due = await engagementsDueForTermEndRefund(institutionId);
  const done: TermEndRefund[] = [];

  for (const candidate of due) {
    const refunded = await db.transaction((tx) =>
      closeWithRefund(tx, { engagementId: candidate.engagementId, institutionId }),
    );
    if (refunded) done.push(refunded);
  }

  return done;
}
