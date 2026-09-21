import { SESSION_MINUTES } from "@/server/modules/engagements/attendance";

export const MINUTES_IN_DAY = 24 * 60;

export type AvailabilityWindow = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export function windowProblem(params: {
  weekday: number;
  startMinute: number;
  endMinute: number;
}): string | null {
  if (!Number.isInteger(params.weekday) || params.weekday < 0 || params.weekday > 6) {
    return "Pick a day of the week.";
  }
  if (!Number.isInteger(params.startMinute) || !Number.isInteger(params.endMinute)) {
    return "Pick a start and end time.";
  }
  if (params.startMinute < 0 || params.endMinute > MINUTES_IN_DAY) {
    return "That time is outside the day.";
  }
  if (params.startMinute >= params.endMinute) {
    return "The end time has to be after the start time.";
  }

  if (params.endMinute - params.startMinute < SESSION_MINUTES) {
    return `Sessions run ${SESSION_MINUTES} minutes, so a window has to be at least that long.`;
  }
  return null;
}

export function slotsPerWeek(windows: readonly AvailabilityWindow[]): number {
  return windows.reduce(
    (total, window) =>
      total + Math.floor((window.endMinute - window.startMinute) / SESSION_MINUTES),
    0,
  );
}
