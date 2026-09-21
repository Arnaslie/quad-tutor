"use server";

import { revalidatePath } from "next/cache";

import { requireTutor } from "@/server/modules/identity/actor";
import {
  addAvailabilityWindow,
  removeAvailabilityWindow,
} from "@/server/modules/tutoring/availability";
import { TutoringError } from "@/server/modules/tutoring/courses";
import {
  addAvailabilityInput,
  removeAvailabilityInput,
} from "@/server/modules/tutoring/input";

export type AvailabilityState =
  | { status: "idle" }
  | { status: "added" }
  | { status: "error"; message: string };

export async function addAvailabilityAction(
  _previous: AvailabilityState,
  formData: FormData,
): Promise<AvailabilityState> {
  const tutor = await requireTutor();

  const parsed = addAvailabilityInput.safeParse({
    weekday: Number(formData.get("weekday")),
    startMinute: Number(formData.get("startMinute")),
    endMinute: Number(formData.get("endMinute")),
  });

  if (!parsed.success) {
    return { status: "error", message: "Pick a day, a start time and an end time." };
  }

  try {
    await addAvailabilityWindow({ tutor, ...parsed.data });
  } catch (error) {
    if (error instanceof TutoringError) return { status: "error", message: error.message };
    throw error;
  }

  revalidatePath("/tutor/availability");
  return { status: "added" };
}

export async function removeAvailabilityAction(formData: FormData): Promise<void> {
  const tutor = await requireTutor();

  const parsed = removeAvailabilityInput.safeParse({
    windowId: formData.get("windowId"),
  });
  if (!parsed.success) return;

  try {
    await removeAvailabilityWindow({ tutor, ...parsed.data });
  } catch (error) {
    if (!(error instanceof TutoringError)) throw error;
  }

  revalidatePath("/tutor/availability");
}
