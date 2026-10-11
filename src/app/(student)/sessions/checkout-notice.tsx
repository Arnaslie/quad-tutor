import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDayTime, formatTime } from "@/components/format";
import { Money } from "@/components/money";
import { packageSummary } from "@/server/modules/billing/pricing";
import type { PendingCheckout } from "@/server/modules/engagements/reads";
import { displayName } from "@/server/modules/identity/display-name";

import { ContinuePayment } from "./continue-payment";
import { RefreshWhilePending } from "./refresh-while-pending";

function Summary({ checkout }: { checkout: PendingCheckout }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="font-medium">
        {checkout.courseCode ?? checkout.courseTitle} · {displayName(checkout.tutorName, "tutor")}
      </p>
      <p className="text-sm text-muted">
        {packageSummary(checkout.kind)} · <Money minor={checkout.amountMinor} currency={checkout.currency} />
        {checkout.slot ? ` · ${formatDayTime(checkout.slot)}` : ""}
      </p>
    </div>
  );
}

export function CheckoutExpired({ checkout }: { checkout: PendingCheckout }) {
  return (
    <Card className="flex flex-col items-start gap-3">
      <Summary checkout={checkout} />
      <p className="text-sm text-muted">
        This checkout ran out before a payment came through, so the time is being
        released. Start again to pick a time.
      </p>
      <ContinuePayment engagementId={checkout.engagementId} label="Start again" pendingLabel="Starting over…" />
    </Card>
  );
}

export function PendingCheckoutCard({ checkout }: { checkout: PendingCheckout }) {
  if (checkout.lapsed) return <CheckoutExpired checkout={checkout} />;

  return (
    <Card className="flex flex-col items-start gap-3">
      <Summary checkout={checkout} />
      <p className="text-sm text-muted">
        Not paid yet. Your time is held until {formatTime(checkout.payBy)}; after
        that it is released and nothing is charged.
      </p>
      <ContinuePayment engagementId={checkout.engagementId} />
    </Card>
  );
}

export function OpenCheckout({ checkout }: { checkout: PendingCheckout | undefined }) {
  if (!checkout || checkout.lapsed) return null;

  return (
    <div className="flex flex-col gap-2">
      <PendingCheckoutCard checkout={checkout} />
      <p className="text-sm text-muted">
        Or pick again below. A different time replaces this checkout.
      </p>
    </div>
  );
}

export function ConfirmingPayment({ checkout }: { checkout: PendingCheckout }) {
  if (checkout.lapsed) return <CheckoutExpired checkout={checkout} />;

  return (
    <Card className="flex flex-col items-start gap-3">
      <RefreshWhilePending />
      <p role="status" className="flex items-center gap-2 font-medium">
        <span className="size-2 animate-pulse rounded-full bg-accent" aria-hidden />
        Confirming your payment with Stripe
      </p>
      <Summary checkout={checkout} />
      <p className="text-sm text-muted">
        This usually takes a few seconds, and this page updates on its own. If you left
        Stripe before paying, your time is held until {formatTime(checkout.payBy)}.
      </p>
      <ContinuePayment engagementId={checkout.engagementId} />
    </Card>
  );
}

export function CheckoutClosed({ restartPath }: { restartPath: string }) {
  return (
    <Card className="flex flex-col items-start gap-3">
      <p className="text-sm">
        That checkout closed before a payment went through, so nothing is booked and the
        time is free again. If your card was charged, the full amount is refunded.
      </p>
      <ButtonLink href={restartPath} variant="secondary">
        Start again
      </ButtonLink>
    </Card>
  );
}

export function CheckoutCancelled() {
  return (
    <Card className="text-sm">
      Checkout cancelled. Nothing was charged, and the time you picked was released.
    </Card>
  );
}
