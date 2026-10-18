import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/server/db";
import { tutorProfile } from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";

import { appUrl } from "./checkout-session";
import { kycStatusOf, payoutStageOf, type KycStatus, type PayoutStage } from "./kyc";
import type { PayoutSpeed } from "./payout-speed";
import { errorFacts, stripeGateway, type ConnectAccount } from "./stripe";

export type Payouts = { accountId: string | null; status: KycStatus; stage: PayoutStage; speed: PayoutSpeed };

export async function payoutsOf(actor: TutorActor): Promise<Payouts> {
  const [row] = await db
    .select({ accountId: tutorProfile.stripeAccountId, status: tutorProfile.kycStatus, speed: tutorProfile.payoutSpeed })
    .from(tutorProfile)
    .where(and(eq(tutorProfile.id, actor.tutorProfileId), eq(tutorProfile.institutionId, actor.institutionId)));
  if (!row) throw new Error("No tutor profile on this campus.");
  return { ...row, stage: row.status };
}

export async function ensureConnectAccount(actor: TutorActor): Promise<string> {
  const existing = await payoutsOf(actor);
  if (existing.accountId) return existing.accountId;
  const account = await stripeGateway().createAccount({
    tutorProfileId: actor.tutorProfileId,
    institutionId: actor.institutionId,
    email: actor.email,
  });
  const [stamped] = await db
    .update(tutorProfile)
    .set({ stripeAccountId: account.id })
    .where(
      and(
        eq(tutorProfile.id, actor.tutorProfileId),
        eq(tutorProfile.institutionId, actor.institutionId),
        isNull(tutorProfile.stripeAccountId),
      ),
    )
    .returning({ id: tutorProfile.id });
  if (stamped) return account.id;
  return (await payoutsOf(actor)).accountId ?? account.id;
}

export async function onboardingLink(actor: TutorActor): Promise<string> {
  const accountId = await ensureConnectAccount(actor);
  return stripeGateway().createAccountLink({
    accountId,
    refreshUrl: appUrl("/tutor/payouts/refresh"),
    returnUrl: appUrl("/tutor/payouts"),
  });
}

/** The stored speed is the tutor's choice; Stripe is set to match it, never the other way. */
async function convergeSpeed(account: ConnectAccount, speed: PayoutSpeed): Promise<void> {
  if (account.payoutSpeed === speed) return;
  try {
    await stripeGateway().setPayoutSpeed(account.id, speed);
  } catch (error) {
    console.error("[connect] payout speed sync failed", errorFacts(error));
  }
}

async function applyAccount(account: ConnectAccount, institutionId: string): Promise<KycStatus | null> {
  const tutorProfileId = account.tutorProfileId;
  if (tutorProfileId !== null && !z.uuid().safeParse(tutorProfileId).success) return null;
  const status = kycStatusOf(account);
  const [row] = await db
    .update(tutorProfile)
    .set({ kycStatus: status })
    .where(
      and(
        eq(tutorProfile.stripeAccountId, account.id),
        eq(tutorProfile.institutionId, institutionId),
        tutorProfileId ? eq(tutorProfile.id, tutorProfileId) : undefined,
      ),
    )
    .returning({ speed: tutorProfile.payoutSpeed });
  if (!row) return null;
  await convergeSpeed(account, row.speed);
  return status;
}

async function refreshAccount(accountId: string, institutionId: string): Promise<{ status: KycStatus; stage: PayoutStage } | null> {
  const account = await stripeGateway().retrieveAccount(accountId);
  const status = await applyAccount(account, institutionId);
  return status ? { status, stage: payoutStageOf(account) } : null;
}

/** Stripe's current word on the account, written to its profile; null when the account is not this campus's tutor. */
export async function refreshKyc(accountId: string, institutionId: string): Promise<KycStatus | null> {
  return (await refreshAccount(accountId, institutionId))?.status ?? null;
}

/** Asks Stripe for the account's current state, so a read works where no webhook is registered (previews). */
export async function payoutsFor(actor: TutorActor): Promise<Payouts> {
  const stored = await payoutsOf(actor);
  if (!stored.accountId) return stored;
  try {
    const fresh = await refreshAccount(stored.accountId, actor.institutionId);
    return fresh ? { ...stored, ...fresh } : stored;
  } catch (error) {
    console.error("[connect] account refresh failed", errorFacts(error));
    return stored;
  }
}

export async function choosePayoutSpeed(actor: TutorActor, speed: PayoutSpeed): Promise<Payouts> {
  const [row] = await db
    .update(tutorProfile)
    .set({ payoutSpeed: speed })
    .where(and(eq(tutorProfile.id, actor.tutorProfileId), eq(tutorProfile.institutionId, actor.institutionId)))
    .returning({ id: tutorProfile.id });
  if (!row) throw new Error("No tutor profile on this campus.");
  return payoutsFor(actor);
}

export type ConnectOutcome = "kyc_synced" | "foreign";

/** Re-retrieves rather than trusting the event payload, so a stale or replayed event never overwrites newer state. */
export async function syncConnectAccount(
  accountId: string,
): Promise<{ outcome: ConnectOutcome; institutionId: string | null }> {
  const account = await stripeGateway().retrieveAccount(accountId);
  if (!z.uuid().safeParse(account.institutionId).success) return { outcome: "foreign", institutionId: null };
  const institutionId = account.institutionId as string;
  const status = await applyAccount(account, institutionId);
  return status ? { outcome: "kyc_synced", institutionId } : { outcome: "foreign", institutionId: null };
}
