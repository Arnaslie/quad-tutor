export const CAMPUS_TIME_ZONE = "America/Chicago";

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(value: Date | string): { date: Date; timeZone: string } {
  if (typeof value === "string" && DAY_ONLY.test(value)) {
    return { date: new Date(`${value}T12:00:00Z`), timeZone: "UTC" };
  }
  return {
    date: typeof value === "string" ? new Date(value) : value,
    timeZone: CAMPUS_TIME_ZONE,
  };
}

export function formatDay(value: Date | string, timeZone?: string): string {
  const it = parts(value);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: timeZone ?? it.timeZone,
  }).format(it.date);
}

export function formatTime(value: Date | string, timeZone = CAMPUS_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(typeof value === "string" ? new Date(value) : value);
}

export function formatDayTime(value: Date | string, timeZone = CAMPUS_TIME_ZONE): string {
  return `${formatDay(value, timeZone)} at ${formatTime(value, timeZone)}`;
}

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
