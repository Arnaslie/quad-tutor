"use server";

import { revalidatePath } from "next/cache";

import { SessionError } from "@/server/modules/engagements/access";
import { outcomeOf, type AnswerOutcome } from "@/server/modules/engagements/answer-outcome";
import { confirmAttendance, denyAttendance } from "@/server/modules/engagements/confirmation";
import {
  cancelSessionInput,
  confirmAttendanceInput,
  denyAttendanceInput,
  setSessionLocationInput,
} from "@/server/modules/engagements/input";
import { cancelSession, setSessionLocation } from "@/server/modules/engagements/scheduling";
import { requireTutor } from "@/server/modules/identity/actor";
import { notifySessionChangesSoon } from "@/server/modules/notifications/soon";

import type { LocationState } from "../location-form";

export type SessionActionState =
  | { status: "idle" }
  | {
      status: "answered";

      answer: "confirmed" | "denied";
      outcome: AnswerOutcome;
    }
  | { status: "cancelled"; late: boolean }
  | { status: "error"; message: string };

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
      notifySessionChangesSoon(actor.institutionId);
      return { status: "answered", answer: "denied", outcome: outcomeOf(result.status) };
    }

    const input = confirmAttendanceInput.parse({ sessionId: formData.get("sessionId") });
    const result = await confirmAttendance({ actor, ...input });
    notifySessionChangesSoon(actor.institutionId);
    return { status: "answered", answer: "confirmed", outcome: outcomeOf(result.status) };
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
    notifySessionChangesSoon(actor.institutionId);
    return { status: "cancelled", late };
  } catch (error) {
    return { status: "error", message: readable(error) };
  }
}

export async function changeSessionLocation(
  _previous: LocationState,
  formData: FormData,
): Promise<LocationState> {
  const actor = await requireTutor();

  const parsed = setSessionLocationInput.safeParse({
    sessionId: formData.get("sessionId"),
    location: formData.get("location"),
  });
  if (!parsed.success) {
    return { status: "error", message: "Say where you meet, in 200 characters or fewer." };
  }

  try {
    await setSessionLocation({ actor, ...parsed.data });
  } catch (error) {
    return { status: "error", message: readable(error) };
  }

  revalidatePath("/tutor/sessions");
  revalidatePath(`/sessions/${parsed.data.sessionId}`);
  return { status: "saved", message: "Moved. The student gets an email with the new spot." };
}

function readable(error: unknown): string {
  if (error instanceof SessionError) return error.message;
  throw error;
}
