/**
 * When a tutor is free.
 *
 * These weekly windows are the only source of bookable times: `availableSlots`
 * walks them in `SESSION_MINUTES` steps, subtracts what is already booked, and
 * that is the list a student picks from. A tutor with no windows cannot be
 * booked at all, however many students want them.
 *
 * The rules about what makes a window valid live in `./windows`, which imports
 * no database so a client form can share them. This file is the part that
 * reads and writes.
 *
 * Removing a window never touches a session already on the calendar. A booking
 * is an agreement between two people; availability only decides what can be
 * offered next.
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { tutorAvailability } from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";
import { TutoringError } from "./courses";
// Not re-exported: this file imports `db`, so a form needing these must import
// them from `./windows` directly. See that file's header and CLAUDE.md.
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

/**
 * Add a window. Overlaps are rejected rather than merged: two windows that
 * overlap generate the same slot twice, and a tutor who meant to move a window
 * should see the one they already have rather than silently acquiring a
 * wider one.
 */
export async function addAvailabilityWindow(params: {
  tutor: TutorActor;
  weekday: number;
  startMinute: number;
  endMinute: number;
}): Promise<{ id: string }> {
  const problem = windowProblem(params);
  if (problem) throw new TutoringError(problem);

  return db.transaction(async (tx) => {
    // Lock this tutor's windows so two tabs cannot both pass the overlap check.
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

/** Scoped to the tutor's own rows: an id from a form is not proof of ownership. */
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

