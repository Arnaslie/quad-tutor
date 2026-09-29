"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOperator } from "@/server/modules/identity/actor";
import { REJECTION_REASONS } from "@/server/modules/tutoring/proof-rules";
import {
  VerificationError,
  rejectClaim,
  verifyClaim,
} from "@/server/modules/tutoring/verification";

export type DecisionState = { status: "idle" } | { status: "error"; message: string };

const decisionInput = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("approve"), tutorCourseId: z.uuid() }),
  z.object({
    intent: z.literal("reject"),
    tutorCourseId: z.uuid(),
    reason: z.enum(REJECTION_REASONS),
  }),
]);

export async function decideClaimAction(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  const operator = await requireOperator();

  const parsed = decisionInput.safeParse({
    intent: formData.get("intent"),
    tutorCourseId: formData.get("tutorCourseId"),
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) {
    return { status: "error", message: "Pick a reason before sending it back." };
  }

  const input = parsed.data;
  try {
    if (input.intent === "approve") {
      await verifyClaim({ operator, tutorCourseId: input.tutorCourseId });
    } else {
      await rejectClaim({ operator, tutorCourseId: input.tutorCourseId, reason: input.reason });
    }
  } catch (error) {
    if (error instanceof VerificationError) return { status: "error", message: error.message };
    throw error;
  }

  revalidatePath("/ops/verifications");
  return { status: "idle" };
}
