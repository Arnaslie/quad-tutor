import { CHECKOUT_PAYABLE_MINUTES } from "@/server/modules/billing/checkout-window";

export function CheckoutFinePrint() {
  return (
    <p className="text-center text-xs text-muted">
      You pay on Stripe&rsquo;s secure checkout page. We hold this time for you for{" "}
      {CHECKOUT_PAYABLE_MINUTES} minutes while you pay, and nothing is booked until the
      payment goes through.
    </p>
  );
}
