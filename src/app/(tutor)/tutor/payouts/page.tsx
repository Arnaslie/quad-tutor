import type { Metadata } from "next";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { payoutsFor } from "@/server/modules/billing/connect";
import type { KycStatus } from "@/server/modules/billing/kyc";
import { requireTutor } from "@/server/modules/identity/actor";

import { startOnboarding } from "./actions";

export const metadata: Metadata = { title: "Payouts" };

const COPY: Record<KycStatus, { status: string; action: string | null }> = {
  not_started: {
    status: "Payouts are not set up yet. Stripe verifies who you are and takes the bank account your pay goes to.",
    action: "Set up payouts",
  },
  pending: {
    status: "Stripe is checking your details. Pay you earn is held for you until it finishes.",
    action: "Review your details",
  },
  verified: {
    status: "Payouts are on. Earned pay goes to your bank daily, usually arriving two business days later.",
    action: null,
  },
  restricted: {
    status: "Stripe needs more information before it can send your pay. Pay you earn is held for you meanwhile.",
    action: "Update your details",
  },
};

export default async function TutorPayoutsPage() {
  const tutor = await requireTutor();
  const payouts = await payoutsFor(tutor);
  const copy = COPY[payouts.status];

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <PageHeader title="Payouts" description="Stripe sends the pay you earn to your bank." />
      <Card>
        <p className="text-sm text-foreground">{copy.status}</p>
      </Card>
      {copy.action ? (
        <form action={startOnboarding}>
          <Button type="submit" size="lg" className="w-full sm:w-auto">
            {payouts.accountId && payouts.status === "not_started" ? "Continue setup" : copy.action}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
