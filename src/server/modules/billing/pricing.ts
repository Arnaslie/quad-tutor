export const SESSION_PRICE_MINOR = 3_500;
export const TAKE_RATE_BP = 1_000;
export const TERM_FEE_CAP_MINOR = 10_000;

export const EXAM_ANCHORED_SESSIONS = 4;

export const THROUGH_FINAL_SESSIONS = 8;
export const THROUGH_FINAL_DISCOUNT_BP = 1_000;

export const TOP_UP_SESSIONS = 1;

export type PackageKind = "exam_anchored" | "through_final" | "top_up";

export const REQUESTABLE_KINDS = ["exam_anchored", "through_final"] as const;
export type RequestedKind = (typeof REQUESTABLE_KINDS)[number];

export function asRequestedKind(kind: PackageKind | null): RequestedKind | null {
  return kind === "exam_anchored" || kind === "through_final" ? kind : null;
}

export const BOOK_AGAIN_ORDER = ["through_final", "exam_anchored", "top_up"] as const;

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

export function bookAgainOpen(params: {
  sessionsRemaining: number;
  termEndsOn: Date;
  now: Date;
}): boolean {
  return params.sessionsRemaining === 0 && params.termEndsOn.getTime() > params.now.getTime();
}

export function packageSummary(kind: PackageKind): string {
  const { sessions } = packageOption(kind);
  if (kind === "through_final") return `${sessions} sessions, through the final`;
  if (kind === "exam_anchored") return `${sessions} sessions, up to the next exam`;
  return "One session";
}

export function perSessionMinor(engagement: {
  pricePaidMinor: number;
  sessionsPurchased: number;
}): number {
  return Math.floor(engagement.pricePaidMinor / engagement.sessionsPurchased);
}

export function splitMinor(
  sessionMinor: number,
  feeChargedThisTermMinor: number,
): { tutorMinor: number; platformMinor: number } {
  const platformMinor = Math.min(
    Math.floor((sessionMinor * TAKE_RATE_BP) / 10_000),
    Math.max(0, TERM_FEE_CAP_MINOR - feeChargedThisTermMinor),
  );
  return { tutorMinor: sessionMinor - platformMinor, platformMinor };
}

export function formatMinor(minor: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}
