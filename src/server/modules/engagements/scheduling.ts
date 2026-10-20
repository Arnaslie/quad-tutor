import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  reliabilityEvent,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import { record } from "@/server/modules/billing/ledger";
import { perSessionMinor } from "@/server/modules/billing/pricing";
import type { RefundRef } from "@/server/modules/billing/refunds";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";

import { availableSlots, confirmationDeadline, lockTutor, slotOpen } from "./slots";
import {
  SessionError,
  heldAgainstPackage,
  lockSession,
  loadParticipation,
  type Executor,
} from "./access";
import {
  LATE_CANCEL_HOURS,
  SESSION_MINUTES,
  isLateCancel,
  remindedAtForNewBooking,
} from "./attendance";
import { cancelRefundsCard, cancelSplit, hoursBefore } from "./cancel-rules";
import { recognise } from "./confirmation";
import { closeIfUsedUp } from "./termEnd";

export async function sessionsRemaining(params: {
  exec?: Executor;
  engagementId: string;
  sessionsPurchased: number;
}): Promise<number> {
  const exec = params.exec ?? db;

  const rows = await exec
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionBooking)
    .where(
      and(eq(sessionBooking.engagementId, params.engagementId), heldAgainstPackage()),
    );

  return Math.max(0, params.sessionsPurchased - (rows.at(0)?.n ?? 0));
}

async function loadBookablePackage(
  actor: Actor,
  engagementId: string,
  lockIn?: Executor,
): Promise<{
  id: string;
  tutorProfileId: string;
  sessionsPurchased: number;
  defaultLocation: string | null;
}> {
  const query = (lockIn ?? db)
    .select({
      id: engagement.id,
      status: engagement.status,
      studentProfileId: engagement.studentProfileId,
      sessionsPurchased: engagement.sessionsPurchased,
      tutorProfileId: tutorProfile.id,
      defaultLocation: tutorProfile.defaultLocation,
      termEnded: sql<boolean>`${term.endsOn} < current_date`,
    })
    .from(engagement)
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(engagement.id, engagementId),
        eq(studentProfile.institutionId, actor.institutionId),
        eq(tutorProfile.institutionId, actor.institutionId),
      ),
    )
    .limit(1);
  const context = lockIn ? await query.for("key share", { of: engagement }) : await query;

  const target = context.at(0);
  if (!target) throw new SessionError("That package does not exist.");
  if (target.studentProfileId !== actor.studentProfileId) {
    throw new SessionError("That package is not yours.");
  }
  if (target.status !== "active") throw new SessionError("That package is closed.");
  if (target.termEnded) {
    throw new SessionError("The term has ended, so this package can no longer be booked.");
  }

  return {
    id: target.id,
    tutorProfileId: target.tutorProfileId,
    sessionsPurchased: target.sessionsPurchased,
    defaultLocation: target.defaultLocation,
  };
}

export async function slotsForEngagement(params: {
  actor: Actor;
  engagementId: string;
}): Promise<Date[]> {
  const target = await loadBookablePackage(params.actor, params.engagementId);

  const remaining = await sessionsRemaining({
    engagementId: target.id,
    sessionsPurchased: target.sessionsPurchased,
  });
  if (remaining <= 0) {
    throw new SessionError("You have used every session in this package.");
  }

  return availableSlots({
    tutorProfileId: target.tutorProfileId,
    institutionId: params.actor.institutionId,
  });
}

export async function bookSession(params: {
  actor: Actor;
  engagementId: string;
  slotStartsAt: Date;
  studentNote?: string | null;
}): Promise<{ sessionId: string; remaining: number }> {
  return db.transaction(async (tx) => {
    const target = await loadBookablePackage(params.actor, params.engagementId, tx);
    await lockTutor(tx, target.tutorProfileId);

    const open = await slotOpen(tx, {
      tutorProfileId: target.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!open) throw new SessionError("That time is no longer available.");

    const remaining = await sessionsRemaining({
      exec: tx,
      engagementId: target.id,
      sessionsPurchased: target.sessionsPurchased,
    });

    if (remaining <= 0) {
      throw new SessionError("You have used every session in this package.");
    }
    // A confirmation closing a used-up package takes it under no key update, which our key share does not
    // block. Read after the count, so a close the count missed is seen here.
    const [current] = await tx
      .select({ status: engagement.status })
      .from(engagement)
      .where(and(eq(engagement.id, target.id), eq(engagement.institutionId, params.actor.institutionId)));
    if (current?.status !== "active") throw new SessionError("That package is closed.");

    const [created] = await tx
      .insert(sessionBooking)
      .values({
        engagementId: target.id,
        institutionId: params.actor.institutionId,
        scheduledAt: params.slotStartsAt,
        durationMinutes: SESSION_MINUTES,
        location: target.defaultLocation,
        studentNote: params.studentNote ?? null,
        confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
        remindedAt: remindedAtForNewBooking(params.slotStartsAt),
      })
      .returning({ id: sessionBooking.id });

    return { sessionId: created.id, remaining: remaining - 1 };
  });
}

export type CancelOutcome = {
  late: boolean;
  keptMinor: number;
  returnedMinor: number;
  currency: string;
  /** What went back to the card: the session's returned share, and anything closing the package refunded. */
  refundedMinor: number;
  /** Refund rows the cancel wrote, each sent to the card after commit. */
  refunds: RefundRef[];
};

/** The session crossed a cancel line between the quote the student saw and the submit. Nothing was cancelled. */
export class CancelQuoteChanged extends SessionError {
  constructor(readonly quote: { keptMinor: number; returnedMinor: number; toCard: boolean; late: boolean }) {
    super("The session is closer now, so cancelling costs something different. Nothing was cancelled. Check the new amount and cancel again.");
  }
}

export async function cancelSession(params: {
  actor: Actor;
  sessionId: string;
  /** The kept share the cancel form showed. A different one on the server's clock refuses the cancel. */
  shownKeptMinor?: number;
}): Promise<CancelOutcome> {
  const now = new Date();

  const cancelled = await db.transaction(async (tx) => {
    // A priced cancel writes ledger rows, whose foreign key takes the engagement for key share.
    // Taking it first keeps the term-end sweep's order: engagement, then its sessions.
    await tx
      .select({ id: engagement.id })
      .from(engagement)
      .innerJoin(sessionBooking, eq(sessionBooking.engagementId, engagement.id))
      .where(
        and(
          eq(sessionBooking.id, params.sessionId),
          eq(sessionBooking.institutionId, params.actor.institutionId),
        ),
      )
      .for("key share", { of: engagement });
    await lockSession(tx, params.sessionId);
    const session = await loadParticipation({
      exec: tx,
      sessionId: params.sessionId,
      actor: params.actor,
    });

    if (session.status !== "scheduled") {
      throw new SessionError("That session is no longer scheduled.");
    }
    if (now.getTime() >= session.scheduledAt.getTime()) {
      throw new SessionError(
        "That session has already started — confirm whether it happened instead.",
      );
    }

    const late = isLateCancel(session.scheduledAt, now);
    const hours = hoursBefore(session.scheduledAt, now);
    const { keptMinor, returnedMinor } = cancelSplit(perSessionMinor(session), hours, session.role);
    const toCard = cancelRefundsCard(session.sessionsPurchased, hours, session.role);
    if (params.shownKeptMinor !== undefined && params.shownKeptMinor !== keptMinor) {
      throw new CancelQuoteChanged({ keptMinor, returnedMinor, toCard, late });
    }

    await tx
      .update(sessionBooking)
      .set({
        status: "cancelled",

        cancelledAt: now,
        cancelledByUserId: params.actor.userId,
      })
      .where(
        and(
          eq(sessionBooking.id, session.sessionId),
          eq(sessionBooking.status, "scheduled"),
        ),
      );

    // TODO(v1): the tutor side of this is `cancelled_at` + `cancelled_by_user_id`

    if (keptMinor > 0) await recognise(tx, session, keptMinor);

    // Naming the session marks it used, so it never goes back in the package.
    const [refund] =
      toCard && returnedMinor > 0
        ? await record(tx, [
            {
              engagementId: session.engagementId,
              institutionId: session.institutionId,
              sessionId: session.sessionId,
              type: "refund",
              amountMinor: returnedMinor,
              currency: session.currency,
            },
          ])
        : [];

    if (late && session.role === "student") {
      await tx.insert(reliabilityEvent).values({
        userId: session.studentUserId,
        institutionId: session.institutionId,
        sessionId: session.sessionId,
        type: "late_cancelled",
        occurredAt: now,
      });
    }

    return {
      late,
      keptMinor,
      returnedMinor,
      currency: session.currency,
      engagementId: session.engagementId,
      used: keptMinor > 0 || toCard,
      refundId: refund?.id ?? null,
    };
  });

  // Its own transaction, so the engagement is locked before its sessions as the term-end sweep does.
  // The cancel has committed either way; a package left open here is refunded at term end or when ended.
  const ids = { engagementId: cancelled.engagementId, institutionId: params.actor.institutionId };
  const closed = cancelled.used
    ? await db
        .transaction((tx) => closeIfUsedUp(tx, ids))
        .catch((error: unknown) => {
          console.error(`[cancel] closing ${ids.engagementId} left for the term-end sweep`, error);
          return null;
        })
    : null;

  const refunds = [cancelled.refundId, closed?.refundId ?? null].flatMap((id) => (id ? [{ ...ids, id }] : []));
  return {
    late: cancelled.late,
    keptMinor: cancelled.keptMinor,
    returnedMinor: cancelled.returnedMinor,
    currency: cancelled.currency,
    refundedMinor: (cancelled.refundId ? cancelled.returnedMinor : 0) + (closed?.refundMinor ?? 0),
    refunds,
  };
}

export async function setSessionLocation(params: {
  actor: TutorActor;
  sessionId: string;
  location: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSession(tx, params.sessionId);
    const session = await loadParticipation({
      exec: tx,
      sessionId: params.sessionId,
      actor: params.actor,
    });

    if (session.role !== "tutor") {
      throw new SessionError("Only the tutor sets where a session happens.");
    }
    const now = new Date();
    if (session.status !== "scheduled" || now >= session.scheduledAt) {
      throw new SessionError("That session has already started or finished.");
    }
    if (isLateCancel(session.scheduledAt, now)) {
      throw new SessionError(
        `Inside ${LATE_CANCEL_HOURS} hours of a session the spot is fixed, so the student is not sent somewhere new at short notice. Cancel if you cannot make it there.`,
      );
    }

    if (session.location === params.location) return;

    await tx
      .update(sessionBooking)
      .set({ location: params.location, locationChangedAt: now })
      .where(eq(sessionBooking.id, session.sessionId));
  });
}
