/**
 * Display formatting. Import these rather than hand-rolling `toLocaleString` in
 * a screen — an exam date that renders a day early on one page and correctly on
 * another destroys the trust the whole product runs on.
 *
 * Two kinds of value come out of the database and they are NOT interchangeable:
 *
 *  - `timestamp` columns arrive as `Date` — a real instant. Render in the
 *    campus timezone.
 *  - `date` columns (`exam.occursOn`, `term.startsOn`) arrive as `"2026-10-14"`
 *    — a calendar day with no instant attached. `new Date("2026-10-14")` parses
 *    that as UTC midnight, which in Central time is the *previous* evening, so
 *    naive formatting shows the exam a day early. `formatDay` handles both.
 */

/** University of Alabama. When campus #2 lands, pass `institution.timezone`. */
export const CAMPUS_TIME_ZONE = "America/Chicago";

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(value: Date | string): { date: Date; timeZone: string } {
  if (typeof value === "string" && DAY_ONLY.test(value)) {
    // Pin to UTC noon and read it back in UTC: no zone shift can move the day.
    return { date: new Date(`${value}T12:00:00Z`), timeZone: "UTC" };
  }
  return {
    date: typeof value === "string" ? new Date(value) : value,
    timeZone: CAMPUS_TIME_ZONE,
  };
}

/** "Tue, Oct 14" */
export function formatDay(value: Date | string, timeZone?: string): string {
  const it = parts(value);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timeZone ?? it.timeZone,
  }).format(it.date);
}

/** "6:30 PM" */
export function formatTime(value: Date | string, timeZone = CAMPUS_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(typeof value === "string" ? new Date(value) : value);
}

/** "Tue, Oct 14 at 6:30 PM" */
export function formatDayTime(value: Date | string, timeZone = CAMPUS_TIME_ZONE): string {
  return `${formatDay(value, timeZone)} at ${formatTime(value, timeZone)}`;
}

/**
 * "in 9h", "in 3 days", "expired". Requests expire at 12h and the countdown is
 * the thing that makes a student send a second ask, so it is worth being exact.
 */
export function formatCountdown(until: Date | string, now = new Date()): string {
  const target = typeof until === "string" ? new Date(until) : until;
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "expired";

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;

  return `in ${Math.round(hours / 24)} days`;
}
