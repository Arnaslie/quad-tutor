import { and, asc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { tutorAvailability } from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";
import { TutoringError } from "./courses";

import { windowProblem, type AvailabilityWindow } from "./windows";

export async function availabilityForTutor(
  tutor: TutorActor,
): Promise<AvailabilityWindow[]> {
  return db
    .select({
      id: tutorAvailability.id,
      weekday: tutorAvailability.weekday,
      startMinute: tutorAvailability.startMinute,
      endMinute: tutorAvailability.endMinute,
    })
    .from(tutorAvailability)
    .where(eq(tutorAvailability.tutorProfileId, tutor.tutorProfileId))
    .orderBy(asc(tutorAvailability.weekday), asc(tutorAvailability.startMinute));
}

export async function addAvailabilityWindow(params: {
  tutor: TutorActor;
  weekday: number;
  startMinute: number;
  endMinute: number;
}): Promise<{ id: string }> {
  const problem = windowProblem(params);
  if (problem) throw new TutoringError(problem);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: tutorAvailability.id,
        startMinute: tutorAvailability.startMinute,
        endMinute: tutorAvailability.endMinute,
      })
      .from(tutorAvailability)
      .where(
        and(
          eq(tutorAvailability.tutorProfileId, params.tutor.tutorProfileId),
          eq(tutorAvailability.weekday, params.weekday),
        ),
      )
      .for("update");

    const overlaps = existing.some(
      (window) =>
        params.startMinute < window.endMinute && window.startMinute < params.endMinute,
    );
    if (overlaps) {
      throw new TutoringError("That overlaps a window you already have that day.");
    }

    const [created] = await tx
      .insert(tutorAvailability)
      .values({
        tutorProfileId: params.tutor.tutorProfileId,
        weekday: params.weekday,
        startMinute: params.startMinute,
        endMinute: params.endMinute,
      })
      .returning({ id: tutorAvailability.id });

    return { id: created.id };
  });
}

export async function removeAvailabilityWindow(params: {
  tutor: TutorActor;
  windowId: string;
}): Promise<void> {
  const removed = await db
    .delete(tutorAvailability)
    .where(
      and(
        eq(tutorAvailability.id, params.windowId),
        eq(tutorAvailability.tutorProfileId, params.tutor.tutorProfileId),
      ),
    )
    .returning({ id: tutorAvailability.id });

  if (!removed.at(0)) throw new TutoringError("That window is no longer there.");
}
