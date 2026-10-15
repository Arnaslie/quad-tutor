export const MIN_RATE_DOLLARS = 1;
export const DEFAULT_RATE_MINOR = 3_500;

const STRIPE_MAX_CHARGE_MINOR = 99_999_999;
const LARGEST_PACKAGE_SESSIONS = 8;
export const MAX_RATE_DOLLARS = Math.floor(STRIPE_MAX_CHARGE_MINOR / LARGEST_PACKAGE_SESSIONS / 100);

export function rateMinorFromDollars(dollars: number): number | null {
  if (!Number.isInteger(dollars)) return null;
  if (dollars < MIN_RATE_DOLLARS || dollars > MAX_RATE_DOLLARS) return null;
  return dollars * 100;
}

export const RATE_RULE = `Whole dollars, at least $${MIN_RATE_DOLLARS}.`;
