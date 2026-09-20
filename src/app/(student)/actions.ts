"use server";

/**
 * The student surface's server actions.
 *
 * These orchestrate and nothing else: parse what the browser sent, get the
 * actor from the session, call one function in `src/server/modules/`, turn a
 * thrown domain error into something a screen can render. No queries live here.
 *
 * Two rules the shapes below exist to enforce:
 *
 *   - `institutionId`, `studentProfileId` and `tutorProfileId` are never in a
 *     schema. The tenant key and the caller's identity come from
 *     `requireActor()`. A form field carrying a campus id is a cross-campus
 *     leak that looks validated.
 *   - Every action returns an `ActionResult` rather than throwing, because a
 *     student who picked a slot that was taken thirty seconds ago needs a
 *     sentence, not an error boundary. The exception is `redirect`, which
 *     throws a control-flow signal on purpose and must not be caught.
 */

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

/**
 * The domain errors are already written for a student to read — that is what
 * `RequestError`, `PurchaseError` and `SessionError` are for. Anything else is
 * a bug and gets a generic line rather than leaking an internal message.
 */
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

/**
 * The deck is the only screen that renders the student's standing — how many
 * tutors they may ask at once, and what clears the limit. Nothing on it is
 * keyed to an id we hold here, so it is invalidated as a route pattern.
 *
 * This is easy to miss because the failure is invisible from the action's own
 * page: a late cancel drops the ask limit from three to two, the write is
 * correct, the session screen updates, and the deck goes on offering three
 * asks until something else happens to refresh it. Any action that writes a
 * reliability fact or changes what is pending has to call this.
 *
 * `type` is required for a path with a dynamic segment — see the
 * `revalidatePath` reference in `node_modules/next/dist/docs/`. The layout
 * above it is deliberately *not* invalidated: the shell renders only the
 * actor's email and whether they have a tutor profile, and no action on this
 * surface changes either. `becomeTutor` does, and that one lives on the tutor
 * surface.
 */
function revalidateStanding(): void {
  revalidatePath("/courses/[offeringId]", "page");
}

/* -------------------------------------------------------------------------- */
/* asking                                                                     */
/* -------------------------------------------------------------------------- */

/** The deck posts ids, not names. */
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
    // Asking for help in a section is the student saying they are in it. The
    // enrollment is idempotent, so re-asking after a decline does not
    // duplicate, and it is what the zero-supply screen writes too.
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

/**
 * Zero tutors is a demand-capture moment, not an error page. The signal we can
 * honestly record today is the enrollment: it is the list of people waiting on
 * this exact section, which is precisely who a "a tutor now covers this"
 * message would go to.
 *
 * TODO(notifications): there is no delivery channel yet — the seam is the same
 * one `remindersDue` in `engagements/reads.ts` is waiting on. The record is
 * real; only the send is missing.
 */
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

/* -------------------------------------------------------------------------- */
/* buying                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The purchase. Ordering is not negotiable and is why this takes a request id
 * and a slot together: the tutor has accepted and a time is picked before any
 * money moves.
 *
 * `anchorExamId` is nullable because a package bought after the last exam of
 * the term has nothing to anchor to.
 */
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

/**
 * One more session with a tutor whose package is finished, late in the term.
 *
 * Nothing about the tutor, the course or the price comes from this form — all
 * three are read from the finished engagement, which is proved to belong to the
 * caller. The only thing posted is which package and which time.
 */
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

/* -------------------------------------------------------------------------- */
/* sessions                                                                   */
/* -------------------------------------------------------------------------- */

/** Sessions 2..N of a package already paid for. */
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

/**
 * Either kind of cancel goes through here. The screen discloses which one this
 * is *before* the button is pressed — inside 12 hours it writes a
 * `late_cancelled` fact — because a consequence a student did not see coming is
 * indistinguishable from a punishment.
 */
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

  // A late cancel wrote a reliability fact, so the ask limit may have moved.
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

  // Settling may have written `attended`, which is what clears a strike.
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
