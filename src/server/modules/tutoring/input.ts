import { z } from "zod";

import { PERIODS, toMinuteOfDay } from "./clock-rules";
import { PROOF_KINDS } from "./proof-rules";
import { RATE_RULE, rateMinorFromDollars } from "./rate-rules";

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

const clockTime = z.object({
  hour: z.coerce.number().int().min(1).max(12),
  minute: z.coerce.number().int().min(0).max(59),
  period: z.enum(PERIODS),
});

export const addAvailabilityInput = z
  .object({ weekday, start: clockTime, end: clockTime })
  .transform(({ weekday, start, end }) => ({
    weekday,
    startMinute: toMinuteOfDay(start, "start"),
    endMinute: toMinuteOfDay(end, "end"),
  }));

export const removeAvailabilityInput = z.object({
  windowId: z.uuid(),
});

export const meetingLocation = z.string().trim().min(1).max(200);

export const setDefaultLocationInput = z.object({ location: meetingLocation });

export const setCourseRateInput = z
  .object({ tutorCourseId: z.uuid(), dollars: z.coerce.number() })
  .transform(({ tutorCourseId, dollars }, ctx) => {
    const rateMinor = rateMinorFromDollars(dollars);
    if (rateMinor === null) {
      ctx.addIssue({ code: "custom", message: RATE_RULE });
      return z.NEVER;
    }
    return { tutorCourseId, rateMinor };
  });

export type ClaimCourseInput = z.infer<typeof claimCourseInput>;
export type AddAvailabilityInput = z.infer<typeof addAvailabilityInput>;
export type RemoveAvailabilityInput = z.infer<typeof removeAvailabilityInput>;
export type SetDefaultLocationInput = z.infer<typeof setDefaultLocationInput>;
