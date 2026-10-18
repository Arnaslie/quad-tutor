import { formatTime } from "@/components/format";

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const END_OF_DAY = 24 * 60;

export function formatMinuteOfDay(minute: number): string {
  if (minute === END_OF_DAY) return "Midnight";
  return formatTime(new Date(Date.UTC(2000, 0, 1, 0, minute)), "UTC");
}

const HALF_HOURS: readonly number[] = Array.from(
  { length: END_OF_DAY / 30 + 1 },
  (_, index) => index * 30,
);

export const START_OPTIONS = HALF_HOURS.slice(0, -1);
export const END_OPTIONS = HALF_HOURS.slice(1);
