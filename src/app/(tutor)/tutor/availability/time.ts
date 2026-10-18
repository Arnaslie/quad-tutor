import { formatTime } from "@/components/format";
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
