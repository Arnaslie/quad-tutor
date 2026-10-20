export const FULL_REFUND_HOURS = 24;
export const QUARTER_REFUND_HOURS = 12;

export type Canceller = "student" | "tutor";

export const HALF_REFUND = { underHours: FULL_REFUND_HOURS, keptBp: 5_000 } as const;
export const QUARTER_REFUND = { underHours: QUARTER_REFUND_HOURS, keptBp: 7_500 } as const;

const STUDENT_TIERS = [QUARTER_REFUND, HALF_REFUND];

export function hoursBefore(scheduledAt: Date, now: Date): number {
  return (scheduledAt.getTime() - now.getTime()) / 3_600_000;
}

export function keptShareBp(hours: number, by: Canceller): number {
  if (by === "tutor") return 0;
  return STUDENT_TIERS.find((tier) => hours < tier.underHours)?.keptBp ?? 0;
}

export function cancelSplit(
  sessionMinor: number,
  hours: number,
  by: Canceller,
): { keptMinor: number; returnedMinor: number } {
  const keptMinor = Math.floor((sessionMinor * keptShareBp(hours, by)) / 10_000);
  return { keptMinor, returnedMinor: sessionMinor - keptMinor };
}

/**
 * Whether a cancel sends what it returns to the card at once. Only a student cancel 24 hours or more ahead, in a
 * package of more than one session, puts the session back in the package instead. A one-time session has no
 * package to go back to, a priced cancel uses the session up, and a tutor cancel refunds it in full.
 */
export function cancelRefundsCard(sessionsPurchased: number, hours: number, by: Canceller): boolean {
  return by === "tutor" || sessionsPurchased === 1 || keptShareBp(hours, by) > 0;
}

/** When the student ends a package, the tutor keeps this share of what is left, rounded down to the cent. */
export const END_FEE_BP = 1_000;

export function endFeeMinor(remainingMinor: number): number {
  return Math.floor((remainingMinor * END_FEE_BP) / 10_000);
}

/**
 * Ending a package charges each session under 24 hours away at its cancel tier, then keeps the end fee from
 * what the ledger still defers beyond those sessions. The two never overlap.
 */
export function endSplit(
  deferredMinor: number,
  sessionMinor: number,
  hoursToEachSession: number[],
): { backMinor: number; tutorMinor: number } {
  const priced = hoursToEachSession
    .map((hours) => cancelSplit(sessionMinor, hours, "student"))
    .filter((split) => split.keptMinor > 0);
  const restMinor = deferredMinor - priced.length * sessionMinor;
  const feeMinor = endFeeMinor(restMinor);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    backMinor: sum(priced.map((split) => split.returnedMinor)) + restMinor - feeMinor,
    tutorMinor: sum(priced.map((split) => split.keptMinor)) + feeMinor,
  };
}
