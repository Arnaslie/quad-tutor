"use server";

import { SessionError } from "@/server/modules/engagements/access";
import {
  confirmAttendance,
  denyAttendance,
  type SessionOutcome,
} from "@/server/modules/engagements/confirmation";
import {
  cancelSessionInput,
  confirmAttendanceInput,
  denyAttendanceInput,
} from "@/server/modules/engagements/input";
import { cancelSession } from "@/server/modules/engagements/scheduling";
import { requireTutor } from "@/server/modules/identity/actor";

/**
 * What the card renders after the tap. Structured rather than a sentence,
 * because the copy differs by role and the other party's name belongs to the
 * page, not to a string built in an action.
 */
export type SessionActionState =
  | { status: "idle" }
  | {
      status: "answered";
      /** What this tutor said, which the copy has to reflect exactly. */
      answer: "confirmed" | "denied";
      outcome: "attended" | "not_attended" | "awaiting_other" | "disputed";
    }
  | { status: "cancelled"; late: boolean }
  | { status: "error"; message: string };

/**
 * `settle()` decides; this only names where the session landed. A session
 * still `scheduled` after an answer means the other party has not answered
 * yet — nothing is wrong.
 */
function outcomeOf(result: SessionOutcome): "attended" | "not_attended" | "awaiting_other" | "disputed" {
  if (result.status === "disputed") return "disputed";
  if (result.status === "scheduled") return "awaiting_other";
  return result.status === "completed" ? "attended" : "not_attended";
}

/**
 * "It happened", or "the student did not show up".
 *
 * The asymmetry is the product, not a UI choice: a tutor who could not make it
 * cancels, so a tutor's denial can only mean the student failed to appear.
 * `denyAttendance` writes that as the `no_showed` fact, and the wording on the
 * button has to match it exactly.
 */
export async function answerSession(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  // A Server Action is a POST endpoint. Identity comes from the session here,
  // never from the form; `loadParticipation` then authorises the session id
  // against this actor.
  const actor = await requireTutor();
  const intent = formData.get("intent");

  try {
    if (intent === "deny") {
      const input = denyAttendanceInput.parse({
        sessionId: formData.get("sessionId"),
        note: formData.get("note") ?? undefined,
      });
      const result = await denyAttendance({ actor, ...input });
      return { status: "answered", answer: "denied", outcome: outcomeOf(result) };
    }

    const input = confirmAttendanceInput.parse({ sessionId: formData.get("sessionId") });
    const result = await confirmAttendance({ actor, ...input });
    return { status: "answered", answer: "confirmed", outcome: outcomeOf(result) };
  } catch (error) {
    return { status: "error", message: readable(error) };
  }
}

/**
 * Cancelling. Inside `LATE_CANCEL_HOURS` it is a late cancel — for a tutor
 * that writes no reliability fact (that table is students only) but it is
 * recorded on the booking, which is where the per-course quality score reads
 * it from. The copy says so rather than pretending the two are the same.
 */
export async function cancelTutorSession(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
  const actor = await requireTutor();

  try {
    const input = cancelSessionInput.parse({ sessionId: formData.get("sessionId") });
    const { late } = await cancelSession({ actor, ...input });
    return { status: "cancelled", late };
  } catch (error) {
    return { status: "error", message: readable(error) };
  }
}

/** `SessionError` messages are written for a person; anything else is not. */
function readable(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  throw error;
}
