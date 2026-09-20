/**
 * What makes an availability window valid, and what one is worth.
 *
 * **This module must not import the database**, and the only thing it does
 * import is `attendance.ts`, which imports nothing either. That is the point:
 * the rules here are shared between the server that enforces them and a form
 * that wants to show the same message before a round trip, and per CLAUDE.md
 * a shared rule lives in a module with no `db` in its graph. Re-exporting
 * these from `availability.ts` would not work — the bundler follows the import
 * graph, not the symbol — so this is the one place to import them from.
 *
 * Minutes from midnight in the institution's timezone, `weekday` matching
 * `Date.prototype.getDay` (0 = Sunday), the same convention the schema
 * documents.
 */

import { SESSION_MINUTES } from "@/server/modules/engagements/attendance";

export const MINUTES_IN_DAY = 24 * 60;

export type AvailabilityWindow = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
};

/**
 * The reasons a window is not usable, as the sentence to show, or null when it
 * is fine. Pure, so the rules can be read without a database and so the form
 * and the server cannot disagree about what is valid.
 *
 * Note it cannot see the tutor's other windows, so it cannot catch an overlap
 * — that check needs the database and lives in `addAvailabilityWindow`. A form
 * calling this still has to handle a rejection from the server.
 */
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
  // A window shorter than one session yields no bookable slots at all, so it
  // would look like availability and behave like none.
  if (params.endMinute - params.startMinute < SESSION_MINUTES) {
    return `Sessions run ${SESSION_MINUTES} minutes, so a window has to be at least that long.`;
  }
  return null;
}

/** How many bookable sessions a week these windows come to. */
export function slotsPerWeek(windows: readonly AvailabilityWindow[]): number {
  return windows.reduce(
    (total, window) =>
      total + Math.floor((window.endMinute - window.startMinute) / SESSION_MINUTES),
    0,
  );
}
