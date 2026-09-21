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

export function formatMinuteOfDay(minute: number): string {
  return formatTime(new Date(Date.UTC(2000, 0, 1, 0, minute)), "UTC");
}

export const TIME_OPTIONS: readonly number[] = Array.from(
  { length: (24 - 6) * 2 + 1 },
  (_, index) => 6 * 60 + index * 30,
);
