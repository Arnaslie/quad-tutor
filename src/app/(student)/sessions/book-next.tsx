"use client";

import { useActionState, useState } from "react";

import { Button, ButtonLink } from "@/components/button";
import { Field, Input } from "@/components/field";
import { formatDay, formatTime } from "@/components/format";

import { book, type ActionResult } from "../actions";

export function BookNext({
  engagementId,
  tutorName,
  slots,
}: {
  engagementId: string;
  tutorName: string;
  slots: string[];
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    book,
    null,
  );
  const [slot, setSlot] = useState<string>(slots.at(0) ?? "");
  const [showAll, setShowAll] = useState(false);

  if (state?.ok) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="status" className="text-sm text-accent">
          Booked. It is on your session board.
        </p>
        <ButtonLink href="/sessions">See your sessions</ButtonLink>
      </div>
    );
  }

  const visible = showAll ? slots : slots.slice(0, 8);

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="engagementId" value={engagementId} />
      <input type="hidden" name="slotStartsAt" value={slot} />

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

      <Field
        id="location-note"
        label="Where (optional)"
        hint="Sessions happen wherever the two of you choose — a library room, a table in the Ferg."
      >
        <Input
          id="location-note"
          name="locationNote"
          maxLength={200}
          placeholder="Gorgas Library, 2nd floor"
        />
      </Field>

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending || slot === ""}>
        {pending ? "Booking…" : "Book this session"}
      </Button>
    </form>
  );
}
