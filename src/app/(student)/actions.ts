"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { awaitCoverage, enroll, offeringById } from "@/server/modules/catalog/courses";
import {
  PurchaseError,
  purchasePackage,
  purchaseTopUp,
} from "@/server/modules/engagements/purchase";
import {
  confirmAttendance,
  denyAttendance,
} from "@/server/modules/engagements/confirmation";
import {
  cancelSessionInput,
  confirmAttendanceInput,
  denyAttendanceInput,
  endPackageInput,
  engagementSlotInput,
  studentNote,
  topUpInput,
} from "@/server/modules/engagements/input";
import { SessionError } from "@/server/modules/engagements/access";
import { bookSession, cancelSession } from "@/server/modules/engagements/scheduling";
import { endPackage } from "@/server/modules/engagements/termEnd";
import { checkoutRedirect } from "@/server/modules/billing/checkout-session";
import { formatMinor } from "@/server/modules/billing/pricing";
import {
  requestRenewalInput,
  requestTutorsInput,
  requestedKind,
} from "@/server/modules/matching/input";
import {
  RequestError,
  requestRenewal,
  requestTutors,
} from "@/server/modules/matching/requests";
import { requireActor } from "@/server/modules/identity/actor";
import { outcomeOf, type AnswerOutcome } from "@/server/modules/engagements/answer-outcome";
import { notifySessionChangesSoon } from "@/server/modules/notifications/soon";
import { rateSession } from "@/server/modules/ratings/capture";
import { rateInput } from "@/server/modules/ratings/input";
import { RatingError } from "@/server/modules/ratings/window";

export type ActionResult =
  | {
      ok: true;
      message?: string;
      answered?: { answer: "confirmed" | "denied"; outcome: AnswerOutcome };
    }
  | { ok: false; error: string };

function toResult(error: unknown): ActionResult {
  if (
    error instanceof RequestError ||
    error instanceof PurchaseError ||
    error instanceof SessionError ||
    error instanceof RatingError
  ) {
    return { ok: false, error: error.message };
  }
  throw error;
}

function revalidateStanding(): void {
  revalidatePath("/courses/[offeringId]", "page");
}

export async function askTutors(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = requestTutorsInput.safeParse({
    courseOfferingId: formData.get("offeringId"),
    tutorCourseIds: formData.getAll("tutorCourseId"),
    kind: formData.get("kind") ?? undefined,
  });

  if (!parsed.success) {
    return { ok: false, error: "Pick at least one tutor, and no more than three." };
  }

  let created: number;
  try {
    await enroll({
      studentProfileId: actor.studentProfileId,
      institutionId: actor.institutionId,
      courseOfferingId: parsed.data.courseOfferingId,
    });

    const result = await requestTutors({
      actor,
      courseOfferingId: parsed.data.courseOfferingId,
      tutorCourseIds: parsed.data.tutorCourseIds,
      kind: parsed.data.kind,
    });
    created = result.created;
  } catch (error) {
    return toResult(error);
  }

  if (created === 0) {
    return {
      ok: false,
      error: "You have already asked them. Check your requests for the answer.",
    };
  }

  revalidateStanding();
  revalidatePath("/requests");
  redirect("/requests");
}

const notifySchema = z.object({ offeringId: z.uuid() });

export async function notifyWhenCovered(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = notifySchema.safeParse({ offeringId: formData.get("offeringId") });
  const offering = parsed.success
    ? await offeringById({ offeringId: parsed.data.offeringId, institutionId: actor.institutionId })
    : null;
  if (!offering) return { ok: false, error: "That section no longer exists." };

  await awaitCoverage({ actor, courseOfferingId: offering.offeringId });

  revalidatePath(`/courses/${offering.offeringId}`);
  return { ok: true, message: "You are on the list for this section." };
}

const purchaseSchema = z.object({
  requestId: z.uuid(),
  kind: requestedKind.optional(),
  anchorExamId: z.uuid().nullable(),
  slotStartsAt: z.coerce.date(),
  studentNote,
});

function noteFrom(formData: FormData): string | undefined {
  const note = formData.get("studentNote");
  return typeof note === "string" && note.trim().length > 0 ? note : undefined;
}

export async function purchase(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const anchor = formData.get("anchorExamId");
  const parsed = purchaseSchema.safeParse({
    requestId: formData.get("requestId"),
    kind: formData.get("kind") ?? undefined,
    anchorExamId: typeof anchor === "string" && anchor.length > 0 ? anchor : null,
    slotStartsAt: formData.get("slotStartsAt"),
    studentNote: noteFrom(formData),
  });

  if (!parsed.success) {
    return { ok: false, error: "Pick a package and a time before checking out." };
  }

  let target: Awaited<ReturnType<typeof checkoutRedirect>>;
  try {
    target = await checkoutRedirect(actor.institutionId, () =>
      purchasePackage({
        actor,
        requestId: parsed.data.requestId,
        kind: parsed.data.kind,
        anchorExamId: parsed.data.anchorExamId,
        slotStartsAt: parsed.data.slotStartsAt,
        studentNote: parsed.data.studentNote,
      }),
    );
  } catch (error) {
    return toResult(error);
  }

  if (target.fulfilled) notifySessionChangesSoon(actor.institutionId);
  revalidatePath("/requests");
  revalidatePath("/sessions");
  redirect(target.url);
}

export async function topUp(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = topUpInput.safeParse({
    tutorCourseId: formData.get("tutorCourseId"),
    slotStartsAt: formData.get("slotStartsAt"),
    studentNote: noteFrom(formData),
  });

  if (!parsed.success) return { ok: false, error: "Pick a time for this session." };

  let target: Awaited<ReturnType<typeof checkoutRedirect>>;
  try {
    target = await checkoutRedirect(actor.institutionId, () =>
      purchaseTopUp({
        actor,
        tutorCourseId: parsed.data.tutorCourseId,
        slotStartsAt: parsed.data.slotStartsAt,
        studentNote: parsed.data.studentNote,
      }),
    );
  } catch (error) {
    return toResult(error);
  }

  if (target.fulfilled) notifySessionChangesSoon(actor.institutionId);
  revalidatePath("/sessions");
  redirect(target.url);
}

export async function askAgain(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = requestRenewalInput.safeParse({
    tutorCourseId: formData.get("tutorCourseId"),
    kind: formData.get("kind"),
  });
  if (!parsed.success) return { ok: false, error: "Pick a package." };

  try {
    await requestRenewal({ actor, ...parsed.data });
  } catch (error) {
    return toResult(error);
  }

  revalidateStanding();
  revalidatePath("/requests");
  revalidatePath("/sessions");
  redirect("/requests");
}

export async function book(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = engagementSlotInput.safeParse({
    engagementId: formData.get("engagementId"),
    slotStartsAt: formData.get("slotStartsAt"),
    studentNote: noteFrom(formData),
  });

  if (!parsed.success) return { ok: false, error: "Pick a time for this session." };

  try {
    await bookSession({
      actor,
      engagementId: parsed.data.engagementId,
      slotStartsAt: parsed.data.slotStartsAt,
      studentNote: parsed.data.studentNote,
    });
  } catch (error) {
    return toResult(error);
  }

  notifySessionChangesSoon(actor.institutionId);
  revalidatePath("/sessions");
  return { ok: true, message: "Booked." };
}

export async function cancel(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = cancelSessionInput.safeParse({ sessionId: formData.get("sessionId") });
  if (!parsed.success) return { ok: false, error: "That session no longer exists." };

  let late: boolean;
  try {
    const result = await cancelSession({ actor, sessionId: parsed.data.sessionId });
    late = result.late;
  } catch (error) {
    return toResult(error);
  }

  notifySessionChangesSoon(actor.institutionId);
  revalidateStanding();
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${parsed.data.sessionId}`);

  return {
    ok: true,
    message: late
      ? "Cancelled. The session goes back in your package and you can rebook it."
      : "Cancelled. The session goes back in your package.",
  };
}

export async function endEarly(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = endPackageInput.safeParse({ engagementId: formData.get("engagementId") });
  if (!parsed.success) return { ok: false, error: "That package no longer exists." };

  let refund: Awaited<ReturnType<typeof endPackage>>;
  try {
    refund = await endPackage({ actor, engagementId: parsed.data.engagementId });
  } catch (error) {
    return toResult(error);
  }
  if (!refund) return { ok: false, error: "That package is already closed." };

  notifySessionChangesSoon(actor.institutionId);
  revalidatePath("/sessions");
  revalidatePath("/sessions/[id]", "page");

  return {
    ok: true,
    message:
      refund.refundMinor > 0
        ? `Package ended. ${formatMinor(refund.refundMinor, refund.currency)} is on its way back to you.`
        : "Package ended.",
  };
}

export async function confirm(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = confirmAttendanceInput.safeParse({
    sessionId: formData.get("sessionId"),
  });
  if (!parsed.success) return { ok: false, error: "That session no longer exists." };

  let outcome: AnswerOutcome;
  try {
    const result = await confirmAttendance({ actor, sessionId: parsed.data.sessionId });
    outcome = outcomeOf(result.status);
  } catch (error) {
    return toResult(error);
  }

  notifySessionChangesSoon(actor.institutionId);
  revalidateStanding();
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { ok: true, answered: { answer: "confirmed", outcome } };
}

export async function deny(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const note = formData.get("note");
  const parsed = denyAttendanceInput.safeParse({
    sessionId: formData.get("sessionId"),
    note: typeof note === "string" && note.trim().length > 0 ? note : undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: "Keep the note under 500 characters." };
  }

  let outcome: AnswerOutcome;
  try {
    const result = await denyAttendance({
      actor,
      sessionId: parsed.data.sessionId,
      note: parsed.data.note ?? null,
    });
    outcome = outcomeOf(result.status);
  } catch (error) {
    return toResult(error);
  }

  notifySessionChangesSoon(actor.institutionId);
  revalidateStanding();
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { ok: true, answered: { answer: "denied", outcome } };
}

export async function rate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = rateInput.safeParse({
    sessionId: formData.get("sessionId"),
    stars: formData.get("stars"),
    note: formData.get("note"),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };

  try {
    await rateSession({ actor, ...parsed.data });
  } catch (error) {
    return toResult(error);
  }

  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { ok: true, message: "Saved. Thanks for rating it." };
}
