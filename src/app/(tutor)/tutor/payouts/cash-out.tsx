"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Money, formatMinor } from "@/components/money";
import type { CashOutOffer } from "@/server/modules/billing/cash-out";
import { INSTANT_FEE, INSTANT_FEE_PERCENT } from "@/server/modules/billing/instant-fee";

import { cashOutNow, type CashOutState } from "./actions";

const FEE_TERMS = `Stripe charges ${INSTANT_FEE_PERCENT} (min ${formatMinor(INSTANT_FEE.minMinor)}, max ${formatMinor(INSTANT_FEE.maxMinor)}).`;

export function CashOut({ offer, requestId }: { offer: CashOutOffer | null; requestId: string }) {
  const [state, action, pending] = useActionState<CashOutState, FormData>(cashOutNow, { status: "idle" });
  const [confirming, setConfirming] = useState(false);

  if (!offer && state.status === "idle") return null;

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Need it sooner?</h2>
      {offer ? (
        <p className="text-sm text-muted">Cash out what you have now instead of waiting for your next payout. It usually lands in minutes. {FEE_TERMS}</p>
      ) : null}

      {offer && confirming ? (
        <form action={action} className="flex flex-col gap-3">
          <input type="hidden" name="netMinor" value={offer.netMinor} />
          <input type="hidden" name="requestId" value={requestId} />
          <dl className="flex flex-col gap-1 rounded-xl bg-surface-sunken px-3 py-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Ready to cash out</dt>
              <dd><Money minor={offer.grossMinor} currency={offer.currency} /></dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Stripe&apos;s fee</dt>
              <dd>−<Money minor={offer.feeMinor} currency={offer.currency} /></dd>
            </div>
            <div className="flex justify-between gap-3 font-semibold">
              <dt>You get</dt>
              <dd><Money minor={offer.netMinor} currency={offer.currency} /></dd>
            </div>
          </dl>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
              {pending ? "Sending…" : `Send ${formatMinor(offer.netMinor, offer.currency)} now`}
            </Button>
            <Button type="button" variant="ghost" size="lg" disabled={pending} onClick={() => setConfirming(false)} className="w-full sm:w-auto">
              Not now
            </Button>
          </div>
        </form>
      ) : offer ? (
        <Button type="button" variant="secondary" size="lg" onClick={() => setConfirming(true)} className="w-full sm:w-auto">
          Cash out now
        </Button>
      ) : null}

      {state.status !== "idle" ? (
        <p aria-live="polite" className={`text-sm ${state.status === "error" ? "text-danger" : "text-foreground"}`}>
          {state.message}
        </p>
      ) : null}
    </Card>
  );
}
