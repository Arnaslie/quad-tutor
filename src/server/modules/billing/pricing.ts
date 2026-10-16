export const TAKE_RATE_BP = 1_000;
export const LOWER_TAKE_RATE_BP = 500;
export const FEE_MILESTONE_MINOR = 10_000;

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

const PACKAGE_SESSIONS: Record<PackageKind, number> = {
  exam_anchored: EXAM_ANCHORED_SESSIONS,
  through_final: THROUGH_FINAL_SESSIONS,
  top_up: TOP_UP_SESSIONS,
};

export function packageOption(kind: PackageKind, rateMinor: number): PackageOption {
  const sessions = PACKAGE_SESSIONS[kind];
  const listMinor = rateMinor * sessions;
  const priceMinor =
    kind === "through_final" ? discounted(listMinor, THROUGH_FINAL_DISCOUNT_BP) : listMinor;
  return {
    kind,
    sessions,
    priceMinor,
    perSessionMinor: Math.floor(priceMinor / sessions),
    savingsMinor: listMinor - priceMinor,
  };
}

export function packageOptions(rateMinor: number): PackageOption[] {
  return REQUESTABLE_KINDS.map((kind) => packageOption(kind, rateMinor));
}

export function topUpOption(rateMinor: number): PackageOption {
  return packageOption("top_up", rateMinor);
}

export function packagePriceRange(
  kind: PackageKind,
  ratesMinor: readonly number[],
): { lowMinor: number; highMinor: number } {
  const prices = ratesMinor.map((rateMinor) => packageOption(kind, rateMinor).priceMinor);
  return { lowMinor: Math.min(...prices), highMinor: Math.max(...prices) };
}

export function bookAgainOpen(params: {
  sessionsRemaining: number;
  termEndsOn: Date;
  now: Date;
}): boolean {
  return params.sessionsRemaining === 0 && params.termEndsOn.getTime() > params.now.getTime();
}

export function packageSummary(kind: PackageKind): string {
  const sessions = PACKAGE_SESSIONS[kind];
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

export function unusedRefundMinor(engagement: {
  pricePaidMinor: number;
  sessionsPurchased: number;
  sessionsDelivered: number;
}): number {
  return Math.max(
    0,
    engagement.pricePaidMinor - engagement.sessionsDelivered * perSessionMinor(engagement),
  );
}

export function milestoneReached(feeToDateMinor: number): boolean {
  return feeToDateMinor >= FEE_MILESTONE_MINOR;
}

const feeAt = (minor: number, rateBp: number) => Math.floor((minor * rateBp) / 10_000);

function platformFeeMinor(sessionMinor: number, feeToDateMinor: number): number {
  if (milestoneReached(feeToDateMinor)) return feeAt(sessionMinor, LOWER_TAKE_RATE_BP);
  const toLineMinor = FEE_MILESTONE_MINOR - feeToDateMinor;
  const fullFeeMinor = feeAt(sessionMinor, TAKE_RATE_BP);
  if (fullFeeMinor <= toLineMinor) return fullFeeMinor;
  const belowLineMinor = (toLineMinor * 10_000) / TAKE_RATE_BP;
  return toLineMinor + feeAt(sessionMinor - belowLineMinor, LOWER_TAKE_RATE_BP);
}

export function splitMinor(
  sessionMinor: number,
  meter: { feeToDateMinor: number },
): { tutorMinor: number; platformMinor: number } {
  const platformMinor = platformFeeMinor(sessionMinor, meter.feeToDateMinor);
  return { tutorMinor: sessionMinor - platformMinor, platformMinor };
}

export function formatMinor(minor: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(minor / 100);
}
