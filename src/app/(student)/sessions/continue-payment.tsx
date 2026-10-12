"use client";

import { useActionState } from "react";

import { Button } from "@/components/button";

import { continueCheckout, type ActionResult } from "../actions";

export function ContinuePayment({
  engagementId,
  label = "Continue to payment",
  pendingLabel = "Opening Stripe…",
}: {
  engagementId: string;
  label?: string;
  pendingLabel?: string;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    continueCheckout,
    null,
  );

  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <input type="hidden" name="engagementId" value={engagementId} />
      <Button type="submit" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
