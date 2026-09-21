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
  courseOffering,
  engagement,
  institution,
  matchRequest,
  sessionBooking,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";
import { record } from "@/server/modules/billing/ledger";

import type { Executor } from "./access";
import {
  packageOption,
  topUpOption,
  topUpWindowOpen,
  type PackageKind,
} from "@/server/modules/billing/pricing";

import { SESSION_MINUTES, remindedAtForNewBooking } from "./attendance";

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
      remindedAt: remindedAtForNewBooking(params.slotStartsAt),
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

/**
 * The finished package a top-up is bought against, proved to belong to the
 * caller and to be inside the end-of-term window.
 *
 * Shared by the slot read and the purchase so the two can never disagree about
 * eligibility — a screen that offers times for a package the write would refuse
 * is worse than one that offers nothing.
 */
async function topUpSource(
  exec: Executor,
  params: { actor: Actor; engagementId: string },
) {
  const remaining = sql<number>`greatest(0, ${engagement.sessionsPurchased} - (
    select count(*)::int from ${sessionBooking}
    where ${sessionBooking.engagementId} = ${engagement.id}
      and ${sessionBooking.status} <> 'cancelled'
  ))`;

  const rows = await exec
    .select({
      id: engagement.id,
      studentProfileId: engagement.studentProfileId,
      tutorCourseId: engagement.tutorCourseId,
      courseOfferingId: engagement.courseOfferingId,
      sessionsRemaining: remaining,
      tutorProfileId: tutorProfile.id,
      tutorUserId: tutorProfile.userId,
      termEndsOn: term.endsOn,
    })
    .from(engagement)
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(engagement.id, params.engagementId),
        eq(tutorProfile.institutionId, params.actor.institutionId),
      ),
    )
    .limit(1);

  const source = rows.at(0);
  if (!source) throw new PurchaseError("That package no longer exists.");
  if (source.studentProfileId !== params.actor.studentProfileId) {
    throw new PurchaseError("That package is not yours.");
  }
  if (
    !topUpWindowOpen({
      sessionsRemaining: source.sessionsRemaining,
      termEndsOn: new Date(`${source.termEndsOn}T12:00:00Z`),
      now: new Date(),
    })
  ) {
    throw new PurchaseError(
      source.sessionsRemaining > 0
        ? "You still have sessions left on that package."
        : "The term is too far out for a single session — buy a package.",
    );
  }

  return source;
}

/** The times a top-up can be booked at, from the tutor the package already has. */
export async function slotsForTopUp(params: {
  actor: Actor;
  engagementId: string;
}): Promise<Date[]> {
  const source = await topUpSource(db, params);

  return availableSlots({
    tutorProfileId: source.tutorProfileId,
    institutionId: params.actor.institutionId,
  });
}

/**
 * One more session with a tutor a student has already finished a package with.
 *
 * A separate engagement rather than sessions appended to the old one: the paid
 * package is a closed record, and stretching `sessionsPurchased` after the fact
 * would reprice delivered sessions — `perSessionMinor` divides price paid by
 * sessions purchased, so every past session on that package would silently
 * become worth less. A new engagement keeps both records true.
 *
 * `matchRequestId` stays null. The column is nullable for exactly this: a
 * renewal has no new request, because the tutor already said yes and making a
 * student ask again is friction with no signal in it.
 *
 * Top-ups chain, deliberately. A booked-but-unheld session leaves nothing left
 * to book, so a second one can be bought before the first happens — which is
 * what a student wanting two sessions in finals week actually needs. Each is
 * its own paid engagement, so nothing about the first is repriced.
 */
export async function purchaseTopUp(params: {
  actor: Actor;
  engagementId: string;
  slotStartsAt: Date;
}): Promise<{ engagementId: string }> {
  const option = topUpOption();

  return db.transaction(async (tx) => {
    const source = await topUpSource(tx, params);

    if (source.tutorUserId === params.actor.userId) {
      throw new PurchaseError("You cannot buy a session from yourself.");
    }

    // TODO(stripe): take payment here, before any row is written, same as
    // `purchasePackage`.

    const [created] = await tx
      .insert(engagement)
      .values({
        studentProfileId: source.studentProfileId,
        tutorCourseId: source.tutorCourseId,
        courseOfferingId: source.courseOfferingId,
        kind: "top_up",
        // No anchor: a top-up is bought against the end of term, not against a
        // specific exam, and inventing one would put a false date on a screen.
        anchorExamId: null,
        sessionsPurchased: option.sessions,
        pricePaidMinor: option.priceMinor,
      })
      .returning({ id: engagement.id });

    await tx.insert(sessionBooking).values({
      engagementId: created.id,
      scheduledAt: params.slotStartsAt,
      durationMinutes: SESSION_MINUTES,
      confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
      remindedAt: remindedAtForNewBooking(params.slotStartsAt),
    });

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
