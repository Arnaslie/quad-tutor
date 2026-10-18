import { formatTime } from "@/components/format";
import { SESSION_MINUTES } from "@/server/modules/engagements/attendance";
import { MINUTES_IN_DAY } from "@/server/modules/tutoring/windows";

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
  if (minute === MINUTES_IN_DAY) return "Midnight";
  return formatTime(new Date(Date.UTC(2000, 0, 1, 0, minute)), "UTC");
}

const HALF_HOURS: readonly number[] = Array.from(
  { length: MINUTES_IN_DAY / 30 + 1 },
  (_, index) => index * 30,
);

export const START_OPTIONS = HALF_HOURS.filter(
  (minute) => minute + SESSION_MINUTES <= MINUTES_IN_DAY,
);
export const END_OPTIONS = HALF_HOURS.filter(
  (minute) => minute >= SESSION_MINUTES,
);
