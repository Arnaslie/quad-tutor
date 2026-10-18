/** Stripe charges this through the Platform Pricing Tool, set by the owner in the Dashboard. Code only discloses it. */
export const INSTANT_FEE = { basisPoints: 175, minMinor: 100, maxMinor: 2_500 } as const;

export const INSTANT_FEE_PERCENT = `${INSTANT_FEE.basisPoints / 100}%`;
