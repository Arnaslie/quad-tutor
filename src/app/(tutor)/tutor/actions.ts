"use server";

import { z } from "zod";

import { requireTutor } from "@/server/modules/identity/actor";
import { requestRef } from "@/server/modules/matching/input";
import {
  RequestError,
  acceptRequest,
  declineRequest,
} from "@/server/modules/matching/requests";

const respondInput = requestRef.extend({
  intent: z.enum(["accept", "pass"]),
});

export type RespondState =
  | { status: "idle" | "accepted" | "passed" }

  | { status: "gone"; message: string };

export async function respondToRequest(
  _previous: RespondState,
  formData: FormData,
): Promise<RespondState> {
  const tutor = await requireTutor();

  const parsed = respondInput.safeParse({
    requestId: formData.get("requestId"),
    intent: formData.get("intent"),
  });

  if (!parsed.success) {
    return { status: "gone", message: "That request could not be read. Reload the page." };
  }

  try {
    if (parsed.data.intent === "pass") {
      await declineRequest({ tutor, requestId: parsed.data.requestId });
      return { status: "passed" };
    }

    await acceptRequest({ tutor, requestId: parsed.data.requestId });
    return { status: "accepted" };
  } catch (error) {
    if (error instanceof RequestError) {
      return { status: "gone", message: error.message };
    }
    throw error;
  }
}
