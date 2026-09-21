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
  locationNote?: string | null;
}): Promise<{ sessionId: string; remaining: number }> {
  const target = await loadBookablePackage(params.actor, params.engagementId);

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
