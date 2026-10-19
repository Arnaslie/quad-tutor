import { randomUUID } from "node:crypto";

import type { Metadata } from "next";

import type { ButtonVariant } from "@/components/button";
import { Card } from "@/components/card";
import { Icon } from "@/components/icons";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { cashOutOffer } from "@/server/modules/billing/cash-out";
import { payoutsFor } from "@/server/modules/billing/connect";
import type { PayoutStage } from "@/server/modules/billing/kyc";
import { PAYOUT_SPEEDS, PAYOUT_SPEED_COPY } from "@/server/modules/billing/payout-speed";
import { requireTutor } from "@/server/modules/identity/actor";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { pickPayoutSpeed, startOnboarding } from "./actions";
import { CashOut } from "./cash-out";
import { OnboardingButton } from "./onboarding-button";
import { SpeedOption } from "./speed-option";
import { PAYOUTS_SUPPORT, STAGE_ICON } from "./stage";

export const metadata: Metadata = { title: "Payouts" };

type Copy = { heading: string; body: string; action: { label: string; variant: ButtonVariant } | null };

const COPY: Record<PayoutStage, Copy> = {
  not_started: {
    heading: "Payouts aren't set up",
    body: "Stripe checks who you are and takes the bank account your pay goes to. Have your bank details and your Social Security number ready. It takes a few minutes.",
    action: { label: "Set up payouts", variant: "primary" },
  },
  pending: {
    heading: "Stripe is checking your details",
    body: "You don't need to do anything right now. If Stripe needs more from you, it shows up here.",
    action: { label: "Review your details", variant: "secondary" },
  },
  restricted: {
    heading: "Stripe needs more from you",
    body: "Stripe can't send your pay until you add what it's asking for.",
    action: { label: "Update your details", variant: "primary" },
  },
  needs_support: {
    heading: "Payouts are blocked on this account",
    body: PAYOUTS_SUPPORT,
    action: null,
  },
  verified: {
    heading: "Payouts are on",
    body: "The pay you earn goes to your bank on its own. There's nothing else to do.",
    action: null,
  },
};

export default async function TutorPayoutsPage() {
  const tutor = await requireTutor();
  const [[payouts, offer], earnings] = await Promise.all([
    payoutsFor(tutor).then(async (payouts) => [payouts, await cashOutOffer(payouts)] as const),
    earningsForTutor(tutor),
  ]);
  const copy = COPY[payouts.stage];
  const icon = STAGE_ICON[payouts.stage];
  const unfinished = payouts.accountId && payouts.stage === "not_started";

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <PageHeader title="Payouts" description="Stripe sends the pay you earn to your bank." />

      <Card className="flex flex-col gap-4">
        <div className="flex gap-3">
          <Icon name={icon.name} className={`mt-0.5 size-5 shrink-0 ${icon.className}`} />
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold tracking-tight">{copy.heading}</h2>
            <p className="text-sm text-muted">{copy.body}</p>
          </div>
        </div>

        {payouts.stage !== "verified" && earnings.owedMinor > 0 ? (
          <p className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-foreground">
            You&apos;re owed{" "}
            <Money minor={earnings.owedMinor} currency={earnings.currency} className="font-semibold" />.
            It&apos;s held for you.
          </p>
        ) : null}

        {copy.action ? (
          <form action={startOnboarding}>
            <OnboardingButton
              label={unfinished ? "Continue setup" : copy.action.label}
              variant={copy.action.variant}
            />
          </form>
        ) : null}
      </Card>

      {payouts.stage === "verified" ? <CashOut offer={offer} requestId={randomUUID()} /> : null}

      {payouts.accountId ? (
        <Card className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">How often you get paid</h2>
          <form action={pickPayoutSpeed} className="flex flex-col gap-2">
            {PAYOUT_SPEEDS.map((speed) => (
              <SpeedOption key={speed} speed={speed} selected={speed === payouts.speed} />
            ))}
          </form>
        </Card>
      ) : null}

      <Card className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-foreground">How payouts work</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>Pay is earned once a session&apos;s attendance settles.</li>
          <li>
            Stripe sends it to your bank {PAYOUT_SPEED_COPY[payouts.speed].when}. It usually arrives two
            business days later.
          </li>
          <li>Stripe collects your bank and ID details, not Quad Tutor.</li>
        </ul>
      </Card>
    </div>
  );
}
