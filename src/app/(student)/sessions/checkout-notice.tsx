import { Card } from "@/components/card";

export function ConfirmingPayment() {
  return (
    <Card className="text-sm">
      Confirming your payment with Stripe. This usually takes a few seconds; refresh
      the page and your session will show as booked. Your time is held for you
      meanwhile.
    </Card>
  );
}

export function CheckoutClosed() {
  return (
    <Card className="text-sm">
      That checkout closed before a payment went through, so nothing is booked and the
      time is free again. If your card was charged, the full amount is refunded.
    </Card>
  );
}

export function CheckoutCancelled() {
  return (
    <Card className="text-sm">
      Checkout cancelled. Nothing was charged, and the time you picked is free again.
    </Card>
  );
}
