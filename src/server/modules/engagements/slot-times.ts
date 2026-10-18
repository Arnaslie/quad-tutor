import { SESSION_MINUTES } from "./attendance";

const MIN_LEAD_HOURS = 12;
const SLOT_HORIZON_DAYS = 14;

export type WeeklyWindow = {
  weekday: number;
  startMinute: number;
  endMinute: number;
};

export function expandSlots(params: {
  windows: readonly WeeklyWindow[];
  timeZone: string;
  now: Date;
  taken: ReadonlySet<number>;
}): Date[] {
  const earliest = params.now.getTime() + MIN_LEAD_HOURS * 60 * 60 * 1000;
  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset < SLOT_HORIZON_DAYS; dayOffset += 1) {
    const day = new Date(params.now);
    day.setDate(day.getDate() + dayOffset);
    day.setHours(0, 0, 0, 0);

    for (const window of params.windows) {
      if (window.weekday !== day.getDay()) continue;

      for (
        let minute = window.startMinute;
        minute + SESSION_MINUTES <= window.endMinute;
        minute += SESSION_MINUTES
      ) {
        const slot = new Date(day);
        slot.setMinutes(minute);
        if (slot.getTime() < earliest) continue;
        if (params.taken.has(slot.getTime())) continue;
        slots.push(slot);
      }
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}
