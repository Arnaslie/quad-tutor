"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Field, Input } from "@/components/field";
import { Money } from "@/components/money";
import { MAX_RATE_DOLLARS, MIN_RATE_DOLLARS, RATE_RULE } from "@/server/modules/tutoring/rate-rules";

import { setCourseRateAction, type RateState } from "./actions";

const INITIAL: RateState = { status: "idle" };

export function RateForm({
  tutorCourseId,
  rateMinor,
}: {
  tutorCourseId: string;
  rateMinor: number;
}) {
  const [state, submit, pending] = useActionState(setCourseRateAction, INITIAL);
  const [openedFrom, setOpenedFrom] = useState<RateState | null>(null);
  const id = useId();

  const open = openedFrom !== null && (openedFrom === state || state.status === "error");

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-x-3">
          <p className="text-sm font-medium text-foreground">
            <Money minor={rateMinor} /> a session
          </p>
          <Button type="button" variant="ghost" onClick={() => setOpenedFrom(state)}>
            Change your rate
          </Button>
        </div>
        {state.status === "saved" ? (
          <p role="status" className="text-sm text-accent">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="tutorCourseId" value={tutorCourseId} />

      <Field
        id={id}
        label="Your rate, in dollars a session"
        hint={RATE_RULE}
        error={state.status === "error" ? state.message : undefined}
      >
        <Input
          id={id}
          name="dollars"
          type="number"
          inputMode="numeric"
          required
          min={MIN_RATE_DOLLARS}
          max={MAX_RATE_DOLLARS}
          step={1}
          defaultValue={rateMinor / 100}
          className="max-w-32"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpenedFrom(null)} disabled={pending}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
