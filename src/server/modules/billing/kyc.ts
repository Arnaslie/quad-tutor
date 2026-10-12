import type { ConnectAccount } from "./stripe";

export type KycStatus = "not_started" | "pending" | "verified" | "restricted";

const STRIPE_REVIEWING = new Set(["requirements.pending_verification", "under_review"]);

export function kycStatusOf(account: Omit<ConnectAccount, "id" | "tutorProfileId" | "institutionId"> | null): KycStatus {
  if (!account) return "not_started";
  const reason = account.disabledReason;
  const pastDue = account.pastDue.length > 0;
  if (account.transfers === "active" && account.payoutsEnabled && !reason && !pastDue) return "verified";
  if (!account.detailsSubmitted) return reason && !reason.startsWith("requirements.") ? "restricted" : "not_started";
  if (pastDue || (reason && !STRIPE_REVIEWING.has(reason))) return "restricted";
  return "pending";
}
