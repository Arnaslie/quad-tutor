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

export type SessionActionState =
  | { status: "idle" }
  | {
      status: "answered";

      answer: "confirmed" | "denied";
      outcome: "attended" | "not_attended" | "awaiting_other" | "disputed";
    }
  | { status: "cancelled"; late: boolean }
  | { status: "error"; message: string };

function outcomeOf(result: SessionOutcome): "attended" | "not_attended" | "awaiting_other" | "disputed" {
  if (result.status === "disputed") return "disputed";
  if (result.status === "scheduled") return "awaiting_other";
  return result.status === "completed" ? "attended" : "not_attended";
}

export async function answerSession(
  _previous: SessionActionState,
  formData: FormData,
): Promise<SessionActionState> {
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

function readable(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  throw error;
}
