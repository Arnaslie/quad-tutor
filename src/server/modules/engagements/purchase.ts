import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  matchRequest,
  sessionBooking,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";
import { record } from "@/server/modules/billing/ledger";

import {
  packageOption,
  packageSummary,
  topUpOption,
  type RequestedKind,
} from "@/server/modules/billing/pricing";

import type { Executor } from "./access";
import { SESSION_MINUTES, remindedAtForNewBooking } from "./attendance";
import { bookAgain } from "./reads";
import { availableSlots, confirmationDeadline, holdSlot, lockTutor } from "./slots";

export class PurchaseError extends Error {}

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
  kind?: RequestedKind;
  anchorExamId: string | null;
  slotStartsAt: Date;
  studentNote?: string | null;
}): Promise<{ engagementId: string }> {
  return db.transaction(async (tx) => {
    const tutorOf = await tx
      .select({ tutorProfileId: tutorCourse.tutorProfileId })
      .from(matchRequest)
      .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
      .where(
        and(
          eq(matchRequest.id, params.requestId),
          eq(matchRequest.institutionId, params.actor.institutionId),
        ),
      )
      .limit(1);
    if (!tutorOf.at(0)) throw new PurchaseError("That request no longer exists.");
    await lockTutor(tx, tutorOf[0].tutorProfileId);

    const rows = await tx
      .select({
        id: matchRequest.id,
        status: matchRequest.status,
        requestedKind: matchRequest.requestedKind,
        studentProfileId: matchRequest.studentProfileId,
        tutorCourseId: matchRequest.tutorCourseId,
        courseOfferingId: matchRequest.courseOfferingId,
        tutorProfileId: tutorCourse.tutorProfileId,
        tutorUserId: tutorProfile.userId,
        defaultLocation: tutorProfile.defaultLocation,
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
      .for("update", { of: matchRequest })
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

    const kind = request.requestedKind ?? params.kind;
    if (!kind || kind === "top_up") throw new PurchaseError("Pick a package.");
    if (params.kind && params.kind !== kind) {
      throw new PurchaseError(`The tutor agreed to ${packageSummary(kind).toLowerCase()}.`);
    }
    const option = packageOption(kind);

    const slotOpen = await holdSlot(tx, {
      tutorProfileId: request.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!slotOpen) throw new PurchaseError("That time is no longer available.");

    // TODO(stripe): take payment here, before any row is written. A failed

    const [created] = await tx
      .insert(engagement)
      .values({
        studentProfileId: request.studentProfileId,
        institutionId: params.actor.institutionId,
        tutorCourseId: request.tutorCourseId,
        courseOfferingId: request.courseOfferingId,
        matchRequestId: request.id,
        kind,
        anchorExamId: params.anchorExamId,
        sessionsPurchased: option.sessions,
        pricePaidMinor: option.priceMinor,
      })
      .returning({ id: engagement.id });

    await tx.insert(sessionBooking).values({
      engagementId: created.id,
      institutionId: params.actor.institutionId,
      scheduledAt: params.slotStartsAt,
      durationMinutes: SESSION_MINUTES,
      location: request.defaultLocation,
      studentNote: params.studentNote ?? null,
      confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
      remindedAt: remindedAtForNewBooking(params.slotStartsAt),
    });

    await record(tx, [
      {
        engagementId: created.id,
        institutionId: params.actor.institutionId,
        type: "package_purchase",
        amountMinor: option.priceMinor,
      },
    ]);

    return { engagementId: created.id };
  });
}

async function refillGate(exec: Executor, params: { actor: Actor; tutorCourseId: string }) {
  const gate = await bookAgain(params.actor, params.tutorCourseId, exec);
  if (!gate) {
    throw new PurchaseError(
      "One more session is for a tutor you already worked with this term, once nothing is left to book.",
    );
  }
  return gate;
}

export async function slotsForTopUp(params: {
  actor: Actor;
  tutorCourseId: string;
}): Promise<Date[]> {
  const gate = await refillGate(db, params);

  return availableSlots({
    tutorProfileId: gate.tutorProfileId,
    institutionId: params.actor.institutionId,
  });
}

export async function purchaseTopUp(params: {
  actor: Actor;
  tutorCourseId: string;
  slotStartsAt: Date;
  studentNote?: string | null;
}): Promise<{ engagementId: string }> {
  const option = topUpOption();

  return db.transaction(async (tx) => {
    const claim = await tx
      .select({ tutorProfileId: tutorCourse.tutorProfileId })
      .from(tutorCourse)
      .where(
        and(
          eq(tutorCourse.id, params.tutorCourseId),
          eq(tutorCourse.institutionId, params.actor.institutionId),
        ),
      )
      .limit(1);
    if (!claim.at(0)) throw new PurchaseError("That tutor no longer offers this course.");
    await lockTutor(tx, claim[0].tutorProfileId);

    const gate = await refillGate(tx, params);

    const slotOpen = await holdSlot(tx, {
      tutorProfileId: gate.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!slotOpen) throw new PurchaseError("That time is no longer available.");

    // TODO(stripe): take payment here, before any row is written, same as

    const [created] = await tx
      .insert(engagement)
      .values({
        studentProfileId: params.actor.studentProfileId,
        institutionId: params.actor.institutionId,
        tutorCourseId: gate.tutorCourseId,
        courseOfferingId: gate.offeringId,
        kind: "top_up",

        anchorExamId: null,
        sessionsPurchased: option.sessions,
        pricePaidMinor: option.priceMinor,
      })
      .returning({ id: engagement.id });

    await tx.insert(sessionBooking).values({
      engagementId: created.id,
      institutionId: params.actor.institutionId,
      scheduledAt: params.slotStartsAt,
      durationMinutes: SESSION_MINUTES,
      location: gate.tutorLocation,
      studentNote: params.studentNote ?? null,
      confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
      remindedAt: remindedAtForNewBooking(params.slotStartsAt),
    });

    await record(tx, [
      {
        engagementId: created.id,
        institutionId: params.actor.institutionId,
        type: "package_purchase",
        amountMinor: option.priceMinor,
      },
    ]);

    return { engagementId: created.id };
  });
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
        institutionId: params.actor.institutionId,
        type: "refund",
        amountMinor: target.pricePaidMinor,
      },
      {
        engagementId: target.id,
        institutionId: params.actor.institutionId,
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
