import { z } from "zod";

export const claimCourseInput = z.object({
  courseId: z.uuid(),
  takenTermId: z.uuid(),

  takenUnderProfessorId: z.uuid().nullish(),

  gradeEarned: z.string().trim().min(1).max(4),
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

export type ClaimCourseInput = z.infer<typeof claimCourseInput>;
export type AddAvailabilityInput = z.infer<typeof addAvailabilityInput>;
export type RemoveAvailabilityInput = z.infer<typeof removeAvailabilityInput>;
