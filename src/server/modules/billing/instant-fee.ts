/** Stripe charges this through the Platform Pricing Tool, set by the owner in the Dashboard. Code only discloses it. */
export const INSTANT_FEE = { basisPoints: 175, minMinor: 100, maxMinor: 2_500 } as const;

/** Stripe's smallest instant payout in USD. */
export const INSTANT_PAYOUT_MIN_MINOR = 50;

export const INSTANT_FEE_PERCENT = `${INSTANT_FEE.basisPoints / 100}%`;
