export const PAYOUT_SPEEDS = ["weekly", "daily"] as const;
export type PayoutSpeed = (typeof PAYOUT_SPEEDS)[number];

export const DEFAULT_PAYOUT_SPEED: PayoutSpeed = "weekly";

export const PAYOUT_SPEED_COPY: Record<PayoutSpeed, { label: string; price: string; when: string }> = {
  weekly: { label: "Weekly", price: "Free", when: "every Friday" },
  daily: { label: "Daily", price: "Free", when: "every business day" },
};
