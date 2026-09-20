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

/**
 * Removing hours. A window that is already gone is not an error — the tutor
 * asked for it not to be there and it is not there — so the only outcome
 * worth rendering is the new list.
 *
 * Sessions already booked out of this window stay booked: a booking is an
 * agreement between two people, and availability only decides what can be
 * offered next.
 */
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
