/**
 * Booking the rest of the package, and cancelling.
 *
 * `purchase.ts` books the first session inside the purchase transaction,
 * because a package with no date on the calendar is a package nobody uses.
 * Sessions two through four are booked here, out of the same availability
 * windows, so there is exactly one definition of what a bookable slot is.
 *
 * Cancellation is a timestamp comparison and nothing else. Inside
 * `LATE_CANCEL_HOURS` it is a late cancel, which writes a
 * `late_cancelled` fact; outside it, it is free and writes nothing. No
 * judgement about the reason is made, recorded, or asked for — that is what
 * keeps reliability a record of facts rather than an opinion about a student.
 *
 * Neither kind of cancellation moves money. The session returns to the package
 * to be rebooked, and anything still unused refunds at term end. Charging for
 * a late cancel would make the consequence unrecoverable, which the product
 * principle in CLAUDE.md rules out.
 */

import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  reliabilityEvent,
  sessionBooking,
  studentProfile,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";

import { availableSlots, confirmationDeadline } from "./purchase";
import { SessionError, lockSession, loadParticipation, type Executor } from "./access";
import { SESSION_MINUTES, isLateCancel, remindedAtForNewBooking } from "./attendance";

/**
 * Sessions left to book. A cancelled booking does not count against the
 * package — that is what "the session comes back" means, and it is why this is
 * derived from the bookings rather than stored as a counter that can drift.
 */
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
      and(
        eq(sessionBooking.engagementId, params.engagementId),
        ne(sessionBooking.status, "cancelled"),
      ),
    );

  return Math.max(0, params.sessionsPurchased - (rows.at(0)?.n ?? 0));
}

/**
 * The package, the tutor behind it, and the authorisation to book against it.
 *
 * Shared by `bookSession` and `slotsForEngagement` so the times a student is
 * shown and the times they are allowed to book are decided by one piece of
 * code. Splitting them is how a UI ends up offering a slot the write path then
 * refuses.
 */
async function loadBookablePackage(
  actor: Actor,
  engagementId: string,
): Promise<{ id: string; tutorProfileId: string; sessionsPurchased: number }> {
  const context = await db
    .select({
      id: engagement.id,
      status: engagement.status,
      studentProfileId: engagement.studentProfileId,
      sessionsPurchased: engagement.sessionsPurchased,
      tutorProfileId: tutorProfile.id,
    })
    .from(engagement)
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(engagement.id, engagementId),
        eq(studentProfile.institutionId, actor.institutionId),
        eq(tutorProfile.institutionId, actor.institutionId),
      ),
    )
    .limit(1);

  const target = context.at(0);
  if (!target) throw new SessionError("That package does not exist.");
  if (target.studentProfileId !== actor.studentProfileId) {
    throw new SessionError("That package is not yours.");
  }
  if (target.status !== "active") throw new SessionError("That package is closed.");

  return {
    id: target.id,
    tutorProfileId: target.tutorProfileId,
    sessionsPurchased: target.sessionsPurchased,
  };
}

/**
 * The times this package's next session can be booked into.
 *
 * Purely a read: `bookSession` re-checks the slot it is given against this
 * same generator inside its transaction, so nothing here is load-bearing for
 * correctness — it exists so the student is shown real choices rather than
 * being told "no longer available" after picking.
 */
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

/**
 * Book the next session of a package.
 *
 * The student books: they are the one with the exam on Thursday. A tutor
 * proposing times is a messaging feature, and messaging is not in this draft.
 */
export async function bookSession(params: {
  actor: Actor;
  engagementId: string;
  slotStartsAt: Date;
  locationNote?: string | null;
}): Promise<{ sessionId: string; remaining: number }> {
  const target = await loadBookablePackage(params.actor, params.engagementId);

  // The same slot generator the purchase flow uses: the tutor's weekly
  // windows, minus what is already booked, minus anything inside the lead time.
  const slots = await availableSlots({
    tutorProfileId: target.tutorProfileId,
    institutionId: params.actor.institutionId,
  });

  const wanted = params.slotStartsAt.getTime();
  if (!slots.some((slot) => slot.getTime() === wanted)) {
    throw new SessionError("That time is no longer available.");
  }

  return db.transaction(async (tx) => {
    const remaining = await sessionsRemaining({
      exec: tx,
      engagementId: target.id,
      sessionsPurchased: target.sessionsPurchased,
    });

    if (remaining <= 0) {
      throw new SessionError("You have used every session in this package.");
    }

    // `availableSlots` ran outside the transaction, so re-check the collision
    // here. Two students booking the same tutor in the same second is rare and
    // entirely possible.
    const clash = await tx
      .select({ id: sessionBooking.id })
      .from(sessionBooking)
      .innerJoin(engagement, eq(engagement.id, sessionBooking.engagementId))
      .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
      .where(
        and(
          eq(tutorCourse.tutorProfileId, target.tutorProfileId),
          eq(sessionBooking.scheduledAt, params.slotStartsAt),
          ne(sessionBooking.status, "cancelled"),
        ),
      )
      .limit(1);

    if (clash.at(0)) throw new SessionError("That time was just taken.");

    const [created] = await tx
      .insert(sessionBooking)
      .values({
        engagementId: target.id,
        scheduledAt: params.slotStartsAt,
        durationMinutes: SESSION_MINUTES,
        locationNote: params.locationNote ?? null,
        confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
        remindedAt: remindedAtForNewBooking(params.slotStartsAt),
      })
      .returning({ id: sessionBooking.id });

    return { sessionId: created.id, remaining: remaining - 1 };
  });
}

/**
 * Cancel a session. Either party, up to the moment it starts; after that the
 * mutual confirm in `confirmation.ts` decides what happened.
 */
export async function cancelSession(params: {
  actor: Actor;
  sessionId: string;
}): Promise<{ late: boolean }> {
  const now = new Date();

  return db.transaction(async (tx) => {
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

    await tx
      .update(sessionBooking)
      .set({
        status: "cancelled",
        // Recorded for both roles. `cancelledAt` against `scheduledAt` is the
        // same timestamp comparison `isLateCancel` just made, so the stats job
        // can re-derive late-ness without trusting anything written here, and
        // `cancelledByUserId` is what attributes a tutor's late cancel to a
        // person. The role is not stored: it is derivable through the
        // engagement, and storing an interpretation we can recompute is how
        // the two diverge.
        cancelledAt: now,
        cancelledByUserId: params.actor.userId,
        // `resolution` stays null on purpose: it answers "did the session
        // happen", and a cancelled session never got as far as the question.
      })
      .where(
        and(
          eq(sessionBooking.id, session.sessionId),
          eq(sessionBooking.status, "scheduled"),
        ),
      );

    // Facts about students only. A tutor's late cancel is real and does matter
    // just as much, but it belongs to the hidden per-course quality score, not
    // to this table — the same person is routinely both, and the histories
    // must not mix.
    //
    // TODO(v1): the tutor side of this is `cancelled_at` + `cancelled_by_user_id`
    // above, which is where the stats job reads it from. Nothing else records
    // it, so a cancellation that does not write those columns is a fact lost
    // for good.
    if (late && session.role === "student") {
      await tx.insert(reliabilityEvent).values({
        userId: session.studentUserId,
        sessionId: session.sessionId,
        type: "late_cancelled",
        occurredAt: now,
      });
    }

    return { late };
  });
}
