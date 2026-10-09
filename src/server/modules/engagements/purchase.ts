import { and, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  matchRequest,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";
import { displayName } from "@/server/modules/identity/display-name";

import {
  packageOption,
  packageSummary,
  topUpOption,
  type PackageKind,
  type RequestedKind,
} from "@/server/modules/billing/pricing";

import type { Executor } from "./access";
import { SESSION_MINUTES, remindedAtForNewBooking } from "./attendance";
import { bookAgain } from "./reads";
import { availableSlots, confirmationDeadline, lockTutor, slotOpen } from "./slots";

export class PurchaseError extends Error {}

export const CHECKOUT_HOLD_MINUTES = 35;

export type Checkout = {
  engagementId: string;
  institutionId: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string;
  expiresAt: Date;
  stripeCheckoutSessionId: string | null;
};

export type PurchaseResult =
  | { outcome: "checkout"; engagementId: string; checkout: Checkout }
  | { outcome: "expired"; engagementId: string; stripeCheckoutSessionId: string | null }
  | { outcome: "paid"; engagementId: string }
  | { outcome: "other_checkout_open"; engagementId: string; stripeCheckoutSessionId: string | null };

const student = alias(user, "student_user");

export async function checkoutDetails(
  exec: Executor,
  params: { engagementId: string; institutionId: string },
): Promise<{ status: (typeof engagement.$inferSelect)["status"]; checkout: Checkout | null } | null> {
  const rows = await exec
    .select({
      engagementId: engagement.id,
      status: engagement.status,
      institutionId: engagement.institutionId,
      kind: engagement.kind,
      amountMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
      expiresAt: engagement.checkoutExpiresAt,
      stripeCheckoutSessionId: engagement.stripeCheckoutSessionId,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      tutorName: user.name,
      customerEmail: student.email,
    })
    .from(engagement)
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(student, eq(student.id, studentProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        eq(engagement.id, params.engagementId),
        eq(engagement.institutionId, params.institutionId),
      ),
    )
    .limit(1);

  const row = rows.at(0);
  if (!row) return null;
  const checkout = row.expiresAt && {
    engagementId: row.engagementId,
    institutionId: row.institutionId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    description: `${row.courseCode ?? row.courseTitle} with ${displayName(row.tutorName, "tutor")}: ${packageSummary(row.kind)}`,
    customerEmail: row.customerEmail,
    expiresAt: row.expiresAt,
    stripeCheckoutSessionId: row.stripeCheckoutSessionId,
  };
  return { status: row.status, checkout };
}

export async function checkoutFor(
  exec: Executor,
  params: { engagementId: string; institutionId: string },
): Promise<PurchaseResult> {
  const found = await checkoutDetails(exec, params);
  const { engagementId } = params;
  if (found && found.status !== "pending_payment" && found.status !== "cancelled") {
    return { outcome: "paid", engagementId };
  }
  if (!found?.checkout || found.status === "cancelled") {
    throw new PurchaseError("That checkout is no longer open.");
  }
  const { checkout } = found;
  if (checkout.expiresAt.getTime() <= Date.now()) {
    return { outcome: "expired", engagementId, stripeCheckoutSessionId: checkout.stripeCheckoutSessionId };
  }
  return { outcome: "checkout", engagementId, checkout };
}

function openCheckouts(exec: Executor, where: SQL | undefined) {
  return exec
    .select({
      id: engagement.id,
      status: engagement.status,
      kind: engagement.kind,
      anchorExamId: engagement.anchorExamId,
      stripeCheckoutSessionId: engagement.stripeCheckoutSessionId,
      slot: sessionBooking.scheduledAt,
    })
    .from(engagement)
    .leftJoin(
      sessionBooking,
      and(eq(sessionBooking.engagementId, engagement.id), eq(sessionBooking.status, "held")),
    )
    .where(where)
    .limit(1);
}

async function resume(
  exec: Executor,
  institutionId: string,
  open: Awaited<ReturnType<typeof openCheckouts>>[number],
  wanted: { kind: PackageKind; anchorExamId: string | null; slotStartsAt: Date },
): Promise<PurchaseResult> {
  const same =
    open.kind === wanted.kind &&
    open.anchorExamId === wanted.anchorExamId &&
    open.slot?.getTime() === wanted.slotStartsAt.getTime();
  if (!same) {
    return {
      outcome: "other_checkout_open",
      engagementId: open.id,
      stripeCheckoutSessionId: open.stripeCheckoutSessionId,
    };
  }
  return checkoutFor(exec, { engagementId: open.id, institutionId });
}

async function hold(
  tx: Executor,
  params: {
    engagement: Omit<typeof engagement.$inferInsert, "status" | "checkoutExpiresAt">;
    slotStartsAt: Date;
    location: string | null;
    studentNote: string | null | undefined;
  },
): Promise<PurchaseResult> {
  const [created] = await tx
    .insert(engagement)
    .values({
      ...params.engagement,
      status: "pending_payment",
      checkoutExpiresAt: new Date(Date.now() + CHECKOUT_HOLD_MINUTES * 60 * 1000),
    })
    .returning({ id: engagement.id });

  await tx.insert(sessionBooking).values({
    engagementId: created.id,
    institutionId: params.engagement.institutionId,
    status: "held",
    scheduledAt: params.slotStartsAt,
    durationMinutes: SESSION_MINUTES,
    location: params.location,
    studentNote: params.studentNote ?? null,
    confirmationWindowEndsAt: confirmationDeadline(params.slotStartsAt),
    remindedAt: remindedAtForNewBooking(params.slotStartsAt),
  });

  return checkoutFor(tx, { engagementId: created.id, institutionId: params.engagement.institutionId });
}

const termEnded = sql<boolean>`${term.endsOn} < current_date`;
const TERM_ENDED = "The term has ended, so this package can no longer be bought.";

export async function slotsForRequest(params: {
  actor: Actor;
  requestId: string;
}): Promise<Date[]> {
  const rows = await db
    .select({
      status: matchRequest.status,
      studentProfileId: matchRequest.studentProfileId,
      tutorProfileId: tutorProfile.id,
      termEnded,
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
    .limit(1);

  const request = rows.at(0);
  if (!request) throw new PurchaseError("That request no longer exists.");
  if (request.studentProfileId !== params.actor.studentProfileId) {
    throw new PurchaseError("That request is not yours.");
  }
  if (request.status !== "accepted") {
    throw new PurchaseError("That request has not been accepted yet.");
  }
  if (request.termEnded) throw new PurchaseError(TERM_ENDED);

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
}): Promise<PurchaseResult> {
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
        termEnded,
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
    if (request.termEnded) throw new PurchaseError(TERM_ENDED);

    const existing = await openCheckouts(
      tx,
      and(eq(engagement.matchRequestId, request.id), ne(engagement.status, "cancelled")),
    );
    const already = existing.at(0);
    if (already && already.status !== "pending_payment") {
      return checkoutFor(tx, { engagementId: already.id, institutionId: params.actor.institutionId });
    }

    const kind = request.requestedKind ?? params.kind;
    if (!kind || kind === "top_up") throw new PurchaseError("Pick a package.");
    if (params.kind && params.kind !== kind) {
      throw new PurchaseError(`The tutor agreed to ${packageSummary(kind).toLowerCase()}.`);
    }
    if (already) {
      return resume(tx, params.actor.institutionId, already, {
        kind,
        anchorExamId: params.anchorExamId,
        slotStartsAt: params.slotStartsAt,
      });
    }
    const option = packageOption(kind);

    const open = await slotOpen(tx, {
      tutorProfileId: request.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!open) throw new PurchaseError("That time is no longer available.");

    return hold(tx, {
      engagement: {
        studentProfileId: request.studentProfileId,
        institutionId: params.actor.institutionId,
        tutorCourseId: request.tutorCourseId,
        courseOfferingId: request.courseOfferingId,
        matchRequestId: request.id,
        kind,
        anchorExamId: params.anchorExamId,
        sessionsPurchased: option.sessions,
        pricePaidMinor: option.priceMinor,
      },
      slotStartsAt: params.slotStartsAt,
      location: request.defaultLocation,
      studentNote: params.studentNote,
    });
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
}): Promise<PurchaseResult> {
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

    const pending = await openCheckouts(
      tx,
      and(
        eq(engagement.studentProfileId, params.actor.studentProfileId),
        eq(engagement.institutionId, params.actor.institutionId),
        eq(engagement.tutorCourseId, gate.tutorCourseId),
        eq(engagement.kind, "top_up"),
        eq(engagement.status, "pending_payment"),
      ),
    );
    const resumed = pending.at(0);
    if (resumed) {
      return resume(tx, params.actor.institutionId, resumed, {
        kind: "top_up",
        anchorExamId: null,
        slotStartsAt: params.slotStartsAt,
      });
    }

    const open = await slotOpen(tx, {
      tutorProfileId: gate.tutorProfileId,
      institutionId: params.actor.institutionId,
      slotStartsAt: params.slotStartsAt,
    });
    if (!open) throw new PurchaseError("That time is no longer available.");

    return hold(tx, {
      engagement: {
        studentProfileId: params.actor.studentProfileId,
        institutionId: params.actor.institutionId,
        tutorCourseId: gate.tutorCourseId,
        courseOfferingId: gate.offeringId,
        kind: "top_up",
        anchorExamId: null,
        sessionsPurchased: option.sessions,
        pricePaidMinor: option.priceMinor,
      },
      slotStartsAt: params.slotStartsAt,
      location: gate.tutorLocation,
      studentNote: params.studentNote,
    });
  });
}
