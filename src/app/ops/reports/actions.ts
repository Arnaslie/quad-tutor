"use server";

import { revalidatePath } from "next/cache";

import { requireOperator } from "@/server/modules/identity/actor";
import { reviewInput } from "@/server/modules/messaging/input";
import { reviewReport } from "@/server/modules/messaging/reports";
import { MessagingError } from "@/server/modules/messaging/threads";

export type ReviewState = { status: "idle" } | { status: "error"; message: string };

export async function reviewReportAction(
  _previous: ReviewState,
  formData: FormData,
): Promise<ReviewState> {
  const operator = await requireOperator();
  const parsed = reviewInput.safeParse({
    reportId: formData.get("reportId"),
    outcome: formData.get("outcome"),
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Pick an outcome." };
  }

  try {
    await reviewReport({ operator, ...parsed.data });
  } catch (error) {
    if (error instanceof MessagingError) return { status: "error", message: error.message };
    throw error;
  }

  revalidatePath("/ops/reports");
  return { status: "idle" };
}
