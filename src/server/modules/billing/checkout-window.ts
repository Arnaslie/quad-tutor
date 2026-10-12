export const CHECKOUT_HOLD_MINUTES = 35;
export const CHECKOUT_RESUME_MARGIN_MINUTES = 5;
export const CHECKOUT_PAYABLE_MINUTES = CHECKOUT_HOLD_MINUTES - CHECKOUT_RESUME_MARGIN_MINUTES;

export function resumableUntil(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - CHECKOUT_RESUME_MARGIN_MINUTES * 60 * 1000);
}
