/**
 * Turning an accepted request into a paid package.
 *
 * Ordering matters and is not negotiable: **charge only after the tutor has
 * accepted and a slot is picked.** Charging at request time, under a double
 * opt-in with three parallel asks, generates a refund queue in week one.
 *
 * There is no Stripe call here yet — see the seam marked TODO(stripe). What is
 * here is the part that outlives any payment provider: the engagement row and
 * the ledger entries that make the money deferred rather than earned.
 */

import { and, eq, gte, ne, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  institution,
  matchRequest,
  sessionBooking,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";
import { record } from "@/server/modules/billing/ledger";
import { packageOption, type PackageKind } from "@/server/modules/billing/pricing";

import { SESSION_MINUTES } from "./attendance";

export class PurchaseError extends Error {}

/** A slot must be far enough out to confirm against. */
const MIN_LEAD_HOURS = 12;
const SLOT_HORIZON_DAYS = 14;

/**
 * Concrete bookable times, generated from the tutor's weekly windows.
 *
 * Single campus, single timezone: slots are built in the server's local time,
 * which is the institution's. A second campus in another zone needs a real
 * conversion here — that is the one place this function is wrong for expansion,
 * and it is why the institution's IANA zone is read rather than assumed.
 */
export async function availableSlots(params: {
  tutorProfileId: string;
  institutionId: string;
}): Promise<Date[]> {
  const [windows, campus] = await Promise.all([
    db
      .select({
        weekday: tutorAvailability.weekday,
        startMinute: tutorAvailability.startMinute,
        endMinute: tutorAvailability.endMinute,
      })
      .from(tutorAvailability)
      .where(eq(tutorAvailability.tutorProfileId, params.tutorProfileId)),
    db
      .select({ timezone: institution.timezone })
      .from(institution)
      .where(eq(institution.id, params.institutionId))
      .limit(1),
  ]);

  if (windows.length === 0 || !campus.at(0)) return [];

  const booked = await db
    .select({ scheduledAt: sessionBooking.scheduledAt })
    .from(sessionBooking)
    .innerJoin(engagement, eq(engagement.id, sessionBooking.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .where(
      and(
        eq(tutorCourse.tutorProfileId, params.tutorProfileId),
        ne(sessionBooking.status, "cancelled"),
        gte(sessionBooking.scheduledAt, new Date()),
      ),
    );

  const taken = new Set(booked.map((row) => row.scheduledAt.getTime()));
  const earliest = Date.now() + MIN_LEAD_HOURS * 60 * 60 * 1000;
  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset < SLOT_HORIZON_DAYS; dayOffset += 1) {
    const day = new Date();
    day.setDate(day.getDate() + dayOffset);
    day.setHours(0, 0, 0, 0);

    for (const window of windows) {
      if (window.weekday !== day.getDay()) continue;

      for (
        let minute = window.startMinute;
        minute + SESSION_MINUTES <= window.endMinute;
        minute += SESSION_MINUTES
      ) {
        const slot = new Date(day);
        slot.setMinutes(minute);
        if (slot.getTime() < earliest) continue;
        if (taken.has(slot.getTime())) continue;
        slots.push(slot);
      }
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The times an accepted request can be turned into a package at.
 *
 * `StudentRequest` deliberately does not carry a `tutorProfileId` — a screen
 * that holds one is a screen that can post one, and profile ids are resolved
 * from the signed-in actor, never accepted from a form. So the tutor is
 * resolved here, from the request, after the request is proved to belong to
 * the caller.
 */
export async function slotsForRequest(params: {
  actor: Actor;
  requestId: string;
}): Promise<Date[]> {
  const rows = await db
    .select({
      status: matchRequest.status,
      studentProfileId: matchRequest.studentProfileId,
      tutorProfileId: tutorProfile.id,
    })
    .from(matchRequest)
    .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .where(
      and(
        eq(matchRequest.id, params.requestId),
        eq(tutorProfile.institutionId, params.actor.institutionId),
      ),
    )
    .limit(1);

  const request = rows.at(0);
  if (!request) throw new PurchaseError("That request no longer exists.");
  if (request.studentProfileId !== params.actor.studentProfileId) {
    throw new PurchaseError("That request is not yours.");
  }
  if (request.status !== "accepted") {
    throw new PurchaseError("That request has not been accepted yet.");
  }

  return availableSlots({
    tutorProfileId: request.tutorProfileId,
    institutionId: params.actor.institutionId,
  });
}

/**
 * The purchase. One transaction: engagement, first booked session, ledger.
 *
 * The unique index on `matchRequestId` is what makes a double submit safe —
 * the second insert fails rather than charging twice.
 */
export async function purchasePackage(params: {
  actor: Actor;
  requestId: string;
  kind: PackageKind;
  anchorExamId: string | null;
  slotStartsAt: Date;
}): Promise<{ engagementId: string }> {
  const option = packageOption(params.kind);

  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: matchRequest.id,
        status: matchRequest.status,
        studentProfileId: matchRequest.studentProfileId,
        tutorCourseId: matchRequest.tutorCourseId,
        courseOfferingId: matchRequest.courseOfferingId,
        tutorProfileId: tutorCourse.tutorProfileId,
        tutorUserId: tutorProfile.userId,
      })
      .from(matchRequest)
      .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
      .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
      .where(
        and(
          eq(matchRequest.id, params.requestId),
          eq(tutorProfile.institutionId, params.actor.institutionId),
        ),
      )
      .for("update")
      .limit(1);

    const request = rows.at(0);
    if (!request) throw new PurchaseError("That request no longer exists.");
    if (request.studentProfileId !== params.actor.studentProfileId) {
      throw new PurchaseError("That request is not yours.");
    }
    if (request.status !== "accepted") {
      throw new PurchaseError("That request has not been accepted yet.");
    }
    // The last gate before an engagement exists, and the one that matters
    // most. A package with the same person on both sides can never settle
    // attendance — `loadParticipation` resolves one role per person, so the
    // session would sit unanswerable forever, money unrecognised, and the
    // symptom would surface weeks later in a ledger reconciliation rather
    // than as anything that looks like a bug. Self-requests predating the
    // matching guards still exist, so this refuses them at the point money
    // would otherwise move.
    if (request.tutorUserId === params.actor.userId) {
      throw new PurchaseError("You cannot buy a package from yourself.");
    }

    const existing = await tx
      .select({ id: engagement.id })
      .from(engagement)
      .where(eq(engagement.matchRequestId, request.id))
      .limit(1);

    const already = existing.at(0);
    if (already) return { engagementId: already.id };

    // TODO(stripe): take payment here, before any row is written. A failed
    // charge must leave no engagement behind and must write a
    // `payment_failed` reliability event for the student.

    const [created] = await tx
      .insert(engagement)
      .values({
        studentProfileId: request.studentProfileId,
        tutorCourseId: request.tutorCourseId,
        courseOfferingId: request.courseOfferingId,
        matchRequestId: request.id,
        kind: params.kind,
        anchorExamId: params.anchorExamId,
        sessionsPurchased: option.sessions,
        pricePaidMinor: option.priceMinor,
      })
      .returning({ id: engagement.id });

    await tx.insert(sessionBooking).values({
      engagementId: created.id,
      scheduledAt: params.slotStartsAt,
      durationMinutes: SESSION_MINUTES,
      confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
    });

    // Cash in, nothing earned. Recognition happens session by session.
    await record(tx, [
      {
        engagementId: created.id,
        type: "package_purchase",
        amountMinor: option.priceMinor,
      },
    ]);

    return { engagementId: created.id };
  });
}

/** Confirmation closes a day after the session ends. */
export function confirmationDeadline(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() + (SESSION_MINUTES + 24 * 60) * 60 * 1000);
}

/**
 * The refund guarantee, self-serve, one per student per term.
 *
 * The platform eats the tutor's pay rather than clawing it back: protecting
 * scarce supply beats recovering thirty dollars. That is what
 * `guarantee_absorbed` records — a real cost, booked where it can be counted.
 */
export async function claimGuarantee(params: {
  actor: Actor;
  engagementId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: engagement.id,
        studentProfileId: engagement.studentProfileId,
        status: engagement.status,
        pricePaidMinor: engagement.pricePaidMinor,
        guaranteeUsed: engagement.guaranteeUsed,
      })
      .from(engagement)
      .where(eq(engagement.id, params.engagementId))
      .for("update")
      .limit(1);

    const target = rows.at(0);
    if (!target) throw new PurchaseError("That package no longer exists.");
    if (target.studentProfileId !== params.actor.studentProfileId) {
      throw new PurchaseError("That package is not yours.");
    }
    if (target.status !== "active") {
      throw new PurchaseError("That package is already closed.");
    }

    const delivered = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionBooking)
      .where(
        and(
          eq(sessionBooking.engagementId, target.id),
          eq(sessionBooking.status, "completed"),
        ),
      );

    if ((delivered.at(0)?.n ?? 0) !== 1) {
      throw new PurchaseError(
        "The guarantee covers your first session — claim it before booking a second.",
      );
    }

    // One per student per term, checked across every package they hold.
    const termUsage = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(engagement)
      .where(
        and(
          eq(engagement.studentProfileId, target.studentProfileId),
          eq(engagement.guaranteeUsed, true),
        ),
      );

    if ((termUsage.at(0)?.n ?? 0) > 0) {
      throw new PurchaseError("You have already used your guarantee this term.");
    }

    // TODO(stripe): issue the refund here; `stripeReference` carries the id.
    await record(tx, [
      {
        engagementId: target.id,
        type: "refund",
        amountMinor: target.pricePaidMinor,
      },
      {
        engagementId: target.id,
        type: "guarantee_absorbed",
        amountMinor: target.pricePaidMinor,
      },
    ]);

    await tx
      .update(engagement)
      .set({ status: "refunded", guaranteeUsed: true, completedAt: new Date() })
      .where(eq(engagement.id, target.id));
  });
}
