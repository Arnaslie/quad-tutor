"use server";

import { z } from "zod";

import { requireTutor } from "@/server/modules/identity/actor";
import { requestRef } from "@/server/modules/matching/input";
import {
  RequestError,
  acceptRequest,
  declineRequest,
} from "@/server/modules/matching/requests";

/**
 * The id is the module's schema; the intent is which of the two buttons was
 * pressed, which is this screen's business and nobody else's.
 */
const respondInput = requestRef.extend({
  intent: z.enum(["accept", "pass"]),
});

export type RespondState =
  | { status: "idle" | "accepted" | "passed" }
  /** Resolved by someone else, or by the clock. Never an error state. */
  | { status: "gone"; message: string };

/**
 * Accept or pass, from the inbox.
 *
 * Accepting is a race the database settles — first accept wins and the
 * student's other asks withdraw in the same transaction — so losing it is a
 * normal outcome, not a failure. `RequestError` messages are written for a
 * person to read and are passed through verbatim.
 */
export async function respondToRequest(
  _previous: RespondState,
  formData: FormData,
): Promise<RespondState> {
  // Re-resolved from the session rather than passed in: a Server Action is a
  // reachable POST endpoint, not just a button on a page that was gated.
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
