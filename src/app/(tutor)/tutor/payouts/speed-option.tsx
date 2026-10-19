"use client";

import { useFormStatus } from "react-dom";

import { PAYOUT_SPEED_COPY, type PayoutSpeed } from "@/server/modules/billing/payout-speed";

export function SpeedOption({ speed, selected }: { speed: PayoutSpeed; selected: boolean }) {
  const { pending } = useFormStatus();
  const copy = PAYOUT_SPEED_COPY[speed];

  return (
    <button
      type={selected ? "button" : "submit"}
      name="speed"
      value={speed}
      aria-pressed={selected}
      disabled={pending}
      className={`flex w-full flex-col gap-1 rounded-2xl border p-4 text-left transition-colors disabled:opacity-60 ${
        selected ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-sunken"
      }`}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{copy.label}</span>
        <span className="text-sm font-semibold">{copy.price}</span>
      </span>
      <span className="text-sm text-muted">Sent {copy.when}.</span>
    </button>
  );
}
