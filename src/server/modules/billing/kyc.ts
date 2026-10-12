import type { ConnectAccount } from "./stripe";

export type KycStatus = "not_started" | "pending" | "verified" | "restricted";

export type PayoutStage = KycStatus | "needs_support";

type AccountState = Omit<ConnectAccount, "id" | "tutorProfileId" | "institutionId"> | null;

const STRIPE_REVIEWING = new Set(["requirements.pending_verification", "under_review"]);

export function kycStatusOf(account: AccountState): KycStatus {
  if (!account) return "not_started";
  const reason = account.disabledReason;
  const pastDue = account.pastDue.length > 0;
  if (account.transfers === "active" && account.payoutsEnabled && !reason && !pastDue) return "verified";
  if (!account.detailsSubmitted) return reason && !reason.startsWith("requirements.") ? "restricted" : "not_started";
  if (pastDue || (reason && !STRIPE_REVIEWING.has(reason))) return "restricted";
  return "pending";
}

/** A restriction that is not a `requirements.*` reason is Stripe's call, so the tutor has nothing to fill in. */
export function payoutStageOf(account: AccountState): PayoutStage {
  const status = kycStatusOf(account);
  const reason = account?.disabledReason;
  return status === "restricted" && reason && !reason.startsWith("requirements.") ? "needs_support" : status;
}
