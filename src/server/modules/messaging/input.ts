import { z } from "zod";

import { MESSAGE_MAX_LENGTH, REPORT_NOTE_MAX_LENGTH, REPORT_OUTCOMES, REPORT_REASONS } from "./rules";

export const sendInput = z.object({
  threadId: z.uuid(),
  body: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(MESSAGE_MAX_LENGTH, `Keep it under ${MESSAGE_MAX_LENGTH} characters.`),
});

const reportFields = {
  reason: z.enum(REPORT_REASONS, "Pick a reason."),
  note: z
    .string()
    .trim()
    .max(REPORT_NOTE_MAX_LENGTH)
    .transform((note) => note || null),
};

export const reportInput = z.object({ threadId: z.uuid(), ...reportFields });

export const ratingReportInput = z.object({ sessionRatingId: z.uuid(), ...reportFields });

export const blockInput = z.object({
  threadId: z.uuid(),
  blocked: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const reviewInput = z.object({
  reportId: z.uuid(),
  outcome: z.enum(REPORT_OUTCOMES, "Pick an outcome."),
});
