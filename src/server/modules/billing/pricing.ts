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

/**
 * The end-of-term top-up: one session, full price, and only ever offered to a
 * student who has already finished a package with that tutor.
 *
 * A cold one-off is a different product and a bad one — no dosage, a take that
 * does not pay for the matching, and a pair who can walk after an hour. None of
 * that applies to a renewal. The matching cost is sunk, the tutor is known, the
 * dosage already happened, and the pair could already have left and did not.
 *
 * What it fixes is the tail of the term. A student who used four sessions and
 * wants one more before finals has, without this, a choice between another
 * four-pack that mostly auto-refunds at term end and texting the tutor
 * directly. The second is free and easier, which is leakage at the exact moment
 * the relationship is worth most.
 *
 * No discount: a top-up is convenience, never a cheaper door into the product.
 */
export const TOP_UP_SESSIONS = 1;

export type PackageKind = "exam_anchored" | "through_final" | "top_up";

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

/**
 * Deliberately not part of `packageOptions()`. That list is what a student
 * chooses from at a first purchase, and a one-session option sitting beside the
 * four-session default would be chosen for the wrong reason — it reads as the
 * cheap way in rather than as what it is.
 */
export function topUpOption(): PackageOption {
  const price = SESSION_PRICE_MINOR * TOP_UP_SESSIONS;
  return {
    kind: "top_up",
    sessions: TOP_UP_SESSIONS,
    priceMinor: price,
    perSessionMinor: SESSION_PRICE_MINOR,
    savingsMinor: 0,
  };
}

export function packageOption(kind: PackageKind): PackageOption {
  const option = [...packageOptions(), topUpOption()].find(
    (candidate) => candidate.kind === kind,
  );
  if (!option) throw new Error(`Unknown package kind: ${kind}`);
  return option;
}

/**
 * Whether a top-up is the right shape for the time left in the term.
 *
 * A package assumes roughly a session a week, so when fewer weeks remain than
 * a package has sessions, selling one is selling sessions the term has no room
 * for — they would auto-refund at term end, which is a refund queue and a
 * student who feels oversold. Inside that window a single session is the
 * honest unit.
 *
 * Pure, and the clock is an argument: this decides what a screen offers, and a
 * function that reads the clock itself cannot be reasoned about from a test.
 */
export function topUpWindowOpen(params: {
  sessionsRemaining: number;
  termEndsOn: Date;
  now: Date;
}): boolean {
  if (params.sessionsRemaining > 0) return false;

  const msLeft = params.termEndsOn.getTime() - params.now.getTime();
  if (msLeft <= 0) return false;

  const weeksLeft = msLeft / (7 * 24 * 60 * 60 * 1000);
  return weeksLeft < EXAM_ANCHORED_SESSIONS;
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
