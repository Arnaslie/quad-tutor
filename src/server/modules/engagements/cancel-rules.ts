export const FULL_REFUND_HOURS = 24;
export const QUARTER_REFUND_HOURS = 12;

export type Canceller = "student" | "tutor";

export const HALF_REFUND = { underHours: FULL_REFUND_HOURS, keptBp: 5_000 } as const;
export const QUARTER_REFUND = { underHours: QUARTER_REFUND_HOURS, keptBp: 7_500 } as const;

const STUDENT_TIERS = [QUARTER_REFUND, HALF_REFUND];

export function hoursBefore(scheduledAt: Date, now: Date): number {
  return (scheduledAt.getTime() - now.getTime()) / 3_600_000;
}

export function keptShareBp(hoursBefore: number, by: Canceller): number {
  if (by === "tutor") return 0;
  return STUDENT_TIERS.find((tier) => hoursBefore < tier.underHours)?.keptBp ?? 0;
}

export function cancelSplit(
  sessionMinor: number,
  hoursBefore: number,
  by: Canceller,
): { keptMinor: number; returnedMinor: number } {
  const keptMinor = Math.floor((sessionMinor * keptShareBp(hoursBefore, by)) / 10_000);
  return { keptMinor, returnedMinor: sessionMinor - keptMinor };
}
