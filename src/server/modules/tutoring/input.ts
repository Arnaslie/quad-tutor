import { z } from "zod";

import { PROOF_KINDS } from "./proof-rules";

export const claimCourseInput = z.object({
  courseId: z.uuid(),
  takenTermId: z.uuid(),

  takenUnderProfessorId: z.uuid().nullish(),

  gradeEarned: z.string().trim().min(1).max(4),
});

export const submitProofInput = z.object({
  tutorCourseId: z.uuid(),
  kind: z.enum(PROOF_KINDS),
});

const weekday = z.number().int().min(0).max(6);

const minuteOfDay = z.number().int().min(0).max(24 * 60);

export const addAvailabilityInput = z.object({
  weekday,
  startMinute: minuteOfDay,
  endMinute: minuteOfDay,
});

export const removeAvailabilityInput = z.object({
  windowId: z.uuid(),
});

export const meetingLocation = z.string().trim().min(1).max(200);

export const setDefaultLocationInput = z.object({ location: meetingLocation });

export type ClaimCourseInput = z.infer<typeof claimCourseInput>;
export type AddAvailabilityInput = z.infer<typeof addAvailabilityInput>;
export type RemoveAvailabilityInput = z.infer<typeof removeAvailabilityInput>;
export type SetDefaultLocationInput = z.infer<typeof setDefaultLocationInput>;
