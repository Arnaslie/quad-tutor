export const MIN_RATE_DOLLARS = 25;
export const MAX_RATE_DOLLARS = 50;
export const DEFAULT_RATE_MINOR = 3_500;

export function rateMinorFromDollars(dollars: number): number | null {
  if (!Number.isInteger(dollars)) return null;
  if (dollars < MIN_RATE_DOLLARS || dollars > MAX_RATE_DOLLARS) return null;
  return dollars * 100;
}

export const RATE_RULE = `A whole number of dollars from $${MIN_RATE_DOLLARS} to $${MAX_RATE_DOLLARS}.`;
