import { z } from "zod";

import { NOTE_MAX, STARS } from "./rules";

export const rateInput = z.object({
  sessionId: z.uuid(),
  stars: z.coerce
    .number("Pick a number of stars.")
    .int()
    .min(STARS[0], "Pick a number of stars.")
    .max(STARS[STARS.length - 1], "Pick a number of stars."),
  note: z
    .string()
    .trim()
    .max(NOTE_MAX, `Keep it under ${NOTE_MAX} characters.`)
    .nullish()
    .transform((note) => note || null),
});

export type RateInput = z.input<typeof rateInput>;
