import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  matchRequest,
  sessionBooking,
  term,
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
import { availableSlots, confirmationDeadline, lockTutor, slotOpen } from "./slots";

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
        termEnded: sql<boolean>`${term.endsOn} < current_date`,
      })
      .from(matchRequest)
      .innerJoin(tutorCourse, eq(tutorCourse.id, matchRequest.tutorCourseId))
      .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
      .innerJoin(courseOffering, eq(courseOffering.id, matchRequest.courseOfferingId))
      .innerJoin(term, eq(term.id, courseOffering.termId))
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
    if (request.termEnded) {
      throw new PurchaseError("The term has ended, so this package can no longer be bought.");
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

    const open = await slotOpen(tx, {
      tutorProfileId: request.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!open) throw new PurchaseError("That time is no longer available.");

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

    const open = await slotOpen(tx, {
      tutorProfileId: gate.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!open) throw new PurchaseError("That time is no longer available.");

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
