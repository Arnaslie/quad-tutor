import { formatTime } from "@/components/format";

/** 0 = Sunday, matching `Date.prototype.getDay` and the `tutor_availability` column. */
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * A window is minutes from midnight in campus wall-clock time, with no date
 * and no instant attached — so it is pinned to a UTC day and read back in UTC.
 * Any other zone would shift the label off the number the tutor picked.
 *
 * Note this goes through `formatTime` rather than around it: one time
 * formatter in the product, however odd the input.
 */
export function formatMinuteOfDay(minute: number): string {
  return formatTime(new Date(Date.UTC(2000, 0, 1, 0, minute)), "UTC");
}

/** Half-hour marks from 6am to midnight — the hours anyone actually tutors. */
export const TIME_OPTIONS: readonly number[] = Array.from(
  { length: (24 - 6) * 2 + 1 },
  (_, index) => 6 * 60 + index * 30,
);
