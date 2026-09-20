/**
 * Boundary schemas for the tutor surfaces, mirroring `engagements/input.ts`.
 *
 * Note what is absent, for the same reason it is absent there: no
 * `institutionId`, no `tutorProfileId`. Both come from the signed-in
 * `TutorActor`. A schema that accepted them would make a cross-campus write
 * look validated.
 */

import { z } from "zod";

export const claimCourseInput = z.object({
  courseId: z.uuid(),
  takenTermId: z.uuid(),
  /** Optional: a course may have no professor recorded for that term. */
  takenUnderProfessorId: z.uuid().nullish(),
  /** Shape only. Whether the grade clears the bar is `isEligibleGrade`. */
  gradeEarned: z.string().trim().min(1).max(4),
});

/** 0 = Sunday, matching `Date.prototype.getDay` and the schema. */
const weekday = z.number().int().min(0).max(6);
/** Minutes from midnight; 1440 is the end of the day, so it is a valid end. */
const minuteOfDay = z.number().int().min(0).max(24 * 60);

export const addAvailabilityInput = z.object({
  weekday,
  startMinute: minuteOfDay,
  endMinute: minuteOfDay,
});

export const removeAvailabilityInput = z.object({
  windowId: z.uuid(),
});

export type ClaimCourseInput = z.infer<typeof claimCourseInput>;
export type AddAvailabilityInput = z.infer<typeof addAvailabilityInput>;
export type RemoveAvailabilityInput = z.infer<typeof removeAvailabilityInput>;
