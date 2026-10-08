"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/button";
import {
  BOOK_AGAIN_ORDER,
  packageOption,
  packageSummary,
  type PackageKind,
} from "@/server/modules/billing/pricing";

import { askAgain, type ActionResult } from "../actions";
import { PackageChoice } from "../package-choice";
import { TopUp } from "./top-up";

export function BookAgainForm({
  tutorCourseId,
  tutorName,
  location,
  currency,
  slots,
}: {
  tutorCourseId: string;
  tutorName: string;
  location: string | null;
  currency: string;
  slots: string[];
}) {
  const [kind, setKind] = useState<PackageKind>(BOOK_AGAIN_ORDER[0]);

  return (
    <div className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          What you want next
        </legend>
        {BOOK_AGAIN_ORDER.map((option) => (
          <PackageChoice
            key={option}
            option={packageOption(option)}
            currency={currency}
            selected={option === kind}
            onSelect={() => setKind(option)}
            extra={option === "top_up" ? " · booked now" : ` · ${tutorName} says yes first`}
          />
        ))}
        <p className="text-sm text-muted">
          A package goes to {tutorName} as an ask, and they accept it before anything
          is charged. One more session books straight into a time they have open.
        </p>
      </fieldset>

      {kind === "top_up" ? (
        slots.length > 0 ? (
          <TopUp
            tutorCourseId={tutorCourseId}
            tutorName={tutorName}
            location={location}
            priceMinor={packageOption("top_up").priceMinor}
            currency={currency}
            slots={slots}
          />
        ) : (
          <p className="rounded-xl bg-surface-sunken px-4 py-3 text-sm text-muted">
            {tutorName} has no times open right now. Their hours change week to week,
            so check back in a day or two, or ask for a package instead.
          </p>
        )
      ) : (
        <AskAgain tutorCourseId={tutorCourseId} tutorName={tutorName} kind={kind} />
      )}
    </div>
  );
}

function AskAgain({
  tutorCourseId,
  tutorName,
  kind,
}: {
  tutorCourseId: string;
  tutorName: string;
  kind: PackageKind;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    askAgain,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="tutorCourseId" value={tutorCourseId} />
      <input type="hidden" name="kind" value={kind} />

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Sending…" : `Ask ${tutorName}`}
      </Button>
      <p className="text-center text-xs text-muted">
        Ask {tutorName} for {packageSummary(kind).toLowerCase()}. They have 12 hours to
        answer, and nothing is charged until they say yes.
      </p>
    </form>
  );
}
