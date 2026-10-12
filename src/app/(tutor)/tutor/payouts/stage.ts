import type { IconName } from "@/components/icons";
import type { PayoutStage } from "@/server/modules/billing/kyc";

export const PAYOUTS_HREF = "/tutor/payouts";

export const SUPPORT_TWITTER_HANDLE = "@ArnasLiesis";

export const PAYOUTS_SUPPORT = `Stripe won't send pay to this account, and it can't be fixed from here. Message ${SUPPORT_TWITTER_HANDLE} on Twitter and we'll sort it out with Stripe.`;

export const STAGE_ICON: Record<PayoutStage, { name: IconName; className: string }> = {
  not_started: { name: "bank", className: "text-muted" },
  pending: { name: "clock", className: "text-muted" },
  restricted: { name: "alert", className: "text-danger" },
  needs_support: { name: "alert", className: "text-danger" },
  verified: { name: "check", className: "text-accent" },
};
