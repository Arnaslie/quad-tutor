import { MINUTES_IN_DAY } from "./windows";

export const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
export const MINUTES: readonly number[] = Array.from({ length: 12 }, (_, index) => index * 5);
export const PERIODS = ["AM", "PM"] as const;

export type ClockTime = { hour: number; minute: number; period: (typeof PERIODS)[number] };

export function toMinuteOfDay(time: ClockTime, edge: "start" | "end"): number {
  const minute = ((time.hour % 12) + (time.period === "PM" ? 12 : 0)) * 60 + time.minute;
  return edge === "end" && minute === 0 ? MINUTES_IN_DAY : minute;
}

export function toClockTime(minuteOfDay: number): ClockTime {
  const minute = minuteOfDay % MINUTES_IN_DAY;
  const hour24 = Math.floor(minute / 60);
  return { hour: hour24 % 12 || 12, minute: minute % 60, period: hour24 < 12 ? "AM" : "PM" };
}
