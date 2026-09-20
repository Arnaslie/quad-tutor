/**
 * Prices and the split. Pure — no I/O, no clock — so the arithmetic is
 * inspectable without a database.
 *
 * Every amount is integer minor units. Never floats: a cent of drift per
 * session becomes a reconciliation problem the moment real money moves.
 *
 * The numbers come from docs/decisions.md and the campus wage floor: UA
 * on-campus tutoring runs ~$10/hr, athletics $10–17.50, so roughly 2× is what
 * makes a peer tutor show up. The take rate sits under Wyzant (~34%) and
 * Preply (~33%) on purpose — undercutting them is cheap here because the
 * course-scoped deck does the matching work those marketplaces charge for.
 */

export const SESSION_PRICE_MINOR = 3_500; // $35.00
export const TAKE_RATE_BP = 2_200; // 22%

/** ~4 sessions to the next exam. The default, and the thing people actually buy. */
export const EXAM_ANCHORED_SESSIONS = 4;
/** The discounted upsell. Fewer renewal boundaries, and each one is a leak. */
export const THROUGH_FINAL_SESSIONS = 8;
export const THROUGH_FINAL_DISCOUNT_BP = 1_000; // 10% off

export type PackageKind = "exam_anchored" | "through_final";

export type PackageOption = {
  kind: PackageKind;
  sessions: number;
  priceMinor: number;
  perSessionMinor: number;
  /** vs. buying the same number of sessions exam-anchored. 0 for the default. */
  savingsMinor: number;
};

function discounted(listMinor: number, discountBp: number): number {
  // Floor, so rounding never charges a cent more than the advertised discount.
  return listMinor - Math.floor((listMinor * discountBp) / 10_000);
}

export function packageOptions(): PackageOption[] {
  const examList = SESSION_PRICE_MINOR * EXAM_ANCHORED_SESSIONS;
  const finalList = SESSION_PRICE_MINOR * THROUGH_FINAL_SESSIONS;
  const finalPrice = discounted(finalList, THROUGH_FINAL_DISCOUNT_BP);

  return [
    {
      kind: "exam_anchored",
      sessions: EXAM_ANCHORED_SESSIONS,
      priceMinor: examList,
      perSessionMinor: Math.floor(examList / EXAM_ANCHORED_SESSIONS),
      savingsMinor: 0,
    },
    {
      kind: "through_final",
      sessions: THROUGH_FINAL_SESSIONS,
      priceMinor: finalPrice,
      perSessionMinor: Math.floor(finalPrice / THROUGH_FINAL_SESSIONS),
      savingsMinor: finalList - finalPrice,
    },
  ];
}

export function packageOption(kind: PackageKind): PackageOption {
  const option = packageOptions().find((candidate) => candidate.kind === kind);
  if (!option) throw new Error(`Unknown package kind: ${kind}`);
  return option;
}

/**
 * What one delivered session is worth against a package already paid for.
 * Derived from what was actually charged, not from the current list price —
 * a price change must never reprice a package someone already bought.
 */
export function perSessionMinor(engagement: {
  pricePaidMinor: number;
  sessionsPurchased: number;
}): number {
  return Math.floor(engagement.pricePaidMinor / engagement.sessionsPurchased);
}

/**
 * The split for one delivered session. Subtraction rather than a second
 * rounding, so the two halves always add back to exactly the whole.
 */
export function splitMinor(sessionMinor: number): {
  tutorMinor: number;
  platformMinor: number;
} {
  const platformMinor = Math.round((sessionMinor * TAKE_RATE_BP) / 10_000);
  return { tutorMinor: sessionMinor - platformMinor, platformMinor };
}

/** Display only. Never do arithmetic on the result. */
export function formatMinor(minor: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}
