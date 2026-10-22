"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/button";
import { CheckoutFinePrint } from "@/components/checkout-fine-print";
import { formatDay, formatTime } from "@/components/format";
import { Money } from "@/components/money";

import { topUp, type ActionResult } from "../actions";
import { MeetingSpot, StudentNoteField } from "../meeting-spot";

export function TopUp({
  tutorCourseId,
  tutorName,
  location,
  priceMinor,
  currency,
  slots,
}: {
  tutorCourseId: string;
  tutorName: string;
  location: string | null;
  priceMinor: number;
  currency: string;
  slots: string[];
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    topUp,
    null,
  );
  const [slot, setSlot] = useState<string>(slots.at(0) ?? "");
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? slots : slots.slice(0, 8);

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="tutorCourseId" value={tutorCourseId} />
      <input type="hidden" name="slotStartsAt" value={slot} />
      <input type="hidden" name="shownPriceMinor" value={priceMinor} />

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          When {tutorName} is free
        </legend>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visible.map((value) => {
            const selected = value === slot;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setSlot(value)}
                aria-pressed={selected}
                className={`flex min-h-11 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border bg-surface hover:bg-surface-sunken"
                }`}
              >
                <span className="font-medium">{formatDay(value)}</span>
                <span className="text-muted">{formatTime(value)}</span>
              </button>
            );
          })}
        </div>

        {slots.length > visible.length ? (
          <Button type="button" variant="ghost" onClick={() => setShowAll(true)}>
            Show all {slots.length} times
          </Button>
        ) : null}
      </fieldset>

      <MeetingSpot tutorName={tutorName} location={location} />

      <StudentNoteField tutorName={tutorName} />

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" disabled={pending || slot === ""}>
          {pending ? (
            "Opening Stripe…"
          ) : (
            <>
              Continue to payment · <Money minor={priceMinor} currency={currency} />
            </>
          )}
        </Button>
        <CheckoutFinePrint />
      </div>
    </form>
  );
}
