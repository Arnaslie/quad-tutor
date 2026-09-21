"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { enroll } from "@/server/modules/catalog/courses";
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
  bookSessionInput,
  cancelSessionInput,
  confirmAttendanceInput,
  denyAttendanceInput,
  purchaseTopUpInput,
} from "@/server/modules/engagements/input";
import { SessionError } from "@/server/modules/engagements/access";
import { bookSession, cancelSession } from "@/server/modules/engagements/scheduling";
import { requestTutorsInput } from "@/server/modules/matching/input";
import { RequestError, requestTutors } from "@/server/modules/matching/requests";
import { requireActor } from "@/server/modules/identity/actor";

export type ActionResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

function toResult(error: unknown): ActionResult {
  if (
    error instanceof RequestError ||
    error instanceof PurchaseError ||
    error instanceof SessionError
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
  });

  if (!parsed.success) {
    return { ok: false, error: "Pick at least one tutor, and no more than three." };
  }

  let created: number;
  try {
    await enroll({
      studentProfileId: actor.studentProfileId,
      courseOfferingId: parsed.data.courseOfferingId,
    });

    const result = await requestTutors({
      actor,
      courseOfferingId: parsed.data.courseOfferingId,
      tutorCourseIds: parsed.data.tutorCourseIds,
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

/** TODO(notifications): the enrollment records who is waiting; nothing sends yet. */
const notifySchema = z.object({ offeringId: z.uuid() });

export async function notifyWhenCovered(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = notifySchema.safeParse({ offeringId: formData.get("offeringId") });
  if (!parsed.success) return { ok: false, error: "That section no longer exists." };

  await enroll({
    studentProfileId: actor.studentProfileId,
    courseOfferingId: parsed.data.offeringId,
  });

  revalidatePath(`/courses/${parsed.data.offeringId}`);
  return { ok: true, message: "You are on the list for this section." };
}

const purchaseSchema = z.object({
  requestId: z.uuid(),
  kind: z.enum(["exam_anchored", "through_final"]),
  anchorExamId: z.uuid().nullable(),
  slotStartsAt: z.coerce.date(),
});

export async function purchase(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const anchor = formData.get("anchorExamId");
  const parsed = purchaseSchema.safeParse({
    requestId: formData.get("requestId"),
    kind: formData.get("kind"),
    anchorExamId: typeof anchor === "string" && anchor.length > 0 ? anchor : null,
    slotStartsAt: formData.get("slotStartsAt"),
  });

  if (!parsed.success) {
    return { ok: false, error: "Pick a package and a time before checking out." };
  }

  let engagementId: string;
  try {
    const result = await purchasePackage({
      actor,
      requestId: parsed.data.requestId,
      kind: parsed.data.kind,
      anchorExamId: parsed.data.anchorExamId,
      slotStartsAt: parsed.data.slotStartsAt,
    });
    engagementId = result.engagementId;
  } catch (error) {
    return toResult(error);
  }

  revalidatePath("/requests");
  revalidatePath("/sessions");
  redirect(`/sessions?package=${engagementId}`);
}

export async function topUp(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = purchaseTopUpInput.safeParse({
    engagementId: formData.get("engagementId"),
    slotStartsAt: formData.get("slotStartsAt"),
  });

  if (!parsed.success) return { ok: false, error: "Pick a time for this session." };

  let engagementId: string;
  try {
    const result = await purchaseTopUp({
      actor,
      engagementId: parsed.data.engagementId,
      slotStartsAt: parsed.data.slotStartsAt,
    });
    engagementId = result.engagementId;
  } catch (error) {
    return toResult(error);
  }

  revalidatePath("/sessions");
  redirect(`/sessions?package=${engagementId}`);
}

export async function book(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const note = formData.get("locationNote");
  const parsed = bookSessionInput.safeParse({
    engagementId: formData.get("engagementId"),
    slotStartsAt: formData.get("slotStartsAt"),
    locationNote: typeof note === "string" && note.trim().length > 0 ? note : undefined,
  });

  if (!parsed.success) return { ok: false, error: "Pick a time for this session." };

  try {
    await bookSession({
      actor,
      engagementId: parsed.data.engagementId,
      slotStartsAt: parsed.data.slotStartsAt,
      locationNote: parsed.data.locationNote,
    });
  } catch (error) {
    return toResult(error);
  }

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

export async function confirm(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await requireActor();

  const parsed = confirmAttendanceInput.safeParse({
    sessionId: formData.get("sessionId"),
  });
  if (!parsed.success) return { ok: false, error: "That session no longer exists." };

  try {
    await confirmAttendance({ actor, sessionId: parsed.data.sessionId });
  } catch (error) {
    return toResult(error);
  }

  revalidateStanding();
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { ok: true, message: "Thanks — that is settled." };
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

  try {
    await denyAttendance({
      actor,
      sessionId: parsed.data.sessionId,
      note: parsed.data.note ?? null,
    });
  } catch (error) {
    return toResult(error);
  }

  revalidateStanding();
  revalidatePath("/sessions");
  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { ok: true, message: "Recorded. Nothing is charged while this is open." };
}
