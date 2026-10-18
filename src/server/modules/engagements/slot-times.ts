import { SESSION_MINUTES } from "./attendance";

const MIN_LEAD_HOURS = 12;
const SLOT_HORIZON_DAYS = 14;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type WeeklyWindow = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

type CalendarDay = { year: number; month: number; day: number };

function campusClock(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });

  function wallClock(instant: number): CalendarDay & { minute: number } {
    const parts = Object.fromEntries(
      format.formatToParts(instant).map((part) => [part.type, Number(part.value)]),
    );
    return {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      minute: parts.hour * 60 + parts.minute,
    };
  }

  function offset(instant: number): number {
    const local = wallClock(instant);
    return Date.UTC(local.year, local.month - 1, local.day, 0, local.minute) - instant;
  }

  function instantAt(day: CalendarDay, minute: number): number | null {
    const asUtc = Date.UTC(day.year, day.month - 1, day.day, 0, minute);
    const candidates = [asUtc - offset(asUtc - DAY_MS), asUtc - offset(asUtc + DAY_MS)];
    return (
      candidates
        .sort((a, b) => a - b)
        .find((candidate) => {
          const local = wallClock(candidate);
          return (
            local.year === day.year &&
            local.month === day.month &&
            local.day === day.day &&
            local.minute === minute
          );
        }) ?? null
    );
  }

  return { wallClock, instantAt };
}

export function expandSlots(params: {
  windows: readonly WeeklyWindow[];
  timeZone: string;
  now: Date;
  taken: ReadonlySet<number>;
}): Date[] {
  const clock = campusClock(params.timeZone);
  const today = clock.wallClock(params.now.getTime());
  const earliest = params.now.getTime() + MIN_LEAD_HOURS * HOUR_MS;
  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset < SLOT_HORIZON_DAYS; dayOffset += 1) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
    const day = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };

    for (const window of params.windows) {
      if (window.weekday !== date.getUTCDay()) continue;

      for (
        let minute = window.startMinute;
        minute + SESSION_MINUTES <= window.endMinute;
        minute += SESSION_MINUTES
      ) {
        const slot = clock.instantAt(day, minute);
        if (slot === null || slot < earliest || params.taken.has(slot)) continue;
        slots.push(new Date(slot));
      }
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}
