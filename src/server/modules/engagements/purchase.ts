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

const MIN_LEAD_HOURS = 12;
const SLOT_HORIZON_DAYS = 14;

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

    const [created] = await tx
      .insert(engagement)
      .values({
        studentProfileId: source.studentProfileId,
        tutorCourseId: source.tutorCourseId,
        courseOfferingId: source.courseOfferingId,
        kind: "top_up",

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

export function confirmationDeadline(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() + (SESSION_MINUTES + 24 * 60) * 60 * 1000);
}

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
