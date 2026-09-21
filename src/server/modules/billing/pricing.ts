export const SESSION_PRICE_MINOR = 3_500;
export const TAKE_RATE_BP = 2_200;

export const EXAM_ANCHORED_SESSIONS = 4;

export const THROUGH_FINAL_SESSIONS = 8;
export const THROUGH_FINAL_DISCOUNT_BP = 1_000;

export const TOP_UP_SESSIONS = 1;

export type PackageKind = "exam_anchored" | "through_final" | "top_up";

export type PackageOption = {
  kind: PackageKind;
  sessions: number;
  priceMinor: number;
  perSessionMinor: number;

  savingsMinor: number;
};

function discounted(listMinor: number, discountBp: number): number {
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

export function perSessionMinor(engagement: {
  pricePaidMinor: number;
  sessionsPurchased: number;
}): number {
  return Math.floor(engagement.pricePaidMinor / engagement.sessionsPurchased);
}

export function splitMinor(sessionMinor: number): {
  tutorMinor: number;
  platformMinor: number;
} {
  const platformMinor = Math.round((sessionMinor * TAKE_RATE_BP) / 10_000);
  return { tutorMinor: sessionMinor - platformMinor, platformMinor };
}

export function formatMinor(minor: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}
