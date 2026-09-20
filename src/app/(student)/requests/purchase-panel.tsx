"use client";

import { useActionState, useState } from "react";

import { Button, ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDay, formatTime } from "@/components/format";
import { Money } from "@/components/money";
import type { PackageKind, PackageOption } from "@/server/modules/billing/pricing";

import { purchase, type ActionResult } from "../actions";

export type ExamChoice = {
  id: string;
  name: string;
  /** A `date` column: a calendar day, not an instant. `formatDay` knows. */
  occursOn: string;
};

/**
 * The purchase. It exists at exactly one moment — after a tutor has accepted
 * and before a time is picked — because charging any earlier, under a double
 * opt-in with three parallel asks, generates a refund queue in week one.
 *
 * Packages are anchored to a real exam rather than to a billing date. That is
 * not decoration: people buy tutoring right after a bad exam grade, and the
 * thing they are buying is "be ready for the next one".
 */
export function PurchasePanel({
  requestId,
  tutorName,
  slots,
  exams,
  options,
}: {
  requestId: string;
  tutorName: string;
  slots: string[];
  exams: ExamChoice[];
  options: PackageOption[];
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    purchase,
    null,
  );
  const [kind, setKind] = useState<PackageKind>("exam_anchored");
  const [slot, setSlot] = useState<string>(slots.at(0) ?? "");
  const [showAllSlots, setShowAllSlots] = useState(false);

  // The default anchors to the next exam; the upsell anchors to the last one
  // on the calendar, which is what "through the final" means. A package bought
  // after the last exam of the term has nothing to anchor to, and that is
  // allowed — `anchorExamId` is nullable for exactly this case.
  const anchor =
    kind === "through_final" ? (exams.at(-1) ?? null) : (exams.at(0) ?? null);

  const visibleSlots = showAllSlots ? slots : slots.slice(0, 8);

  if (slots.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">
            {tutorName} has no times open right now
          </h2>
          <p className="text-sm text-muted">
            Nothing is charged until you pick one, so nothing is lost. Their
            hours change week to week — check back, or ask someone else.
          </p>
        </div>
        <ButtonLink href="/requests" variant="secondary">
          Back to your asks
        </ButtonLink>
      </Card>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-6">
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="anchorExamId" value={anchor?.id ?? ""} />
      <input type="hidden" name="slotStartsAt" value={slot} />

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          How many sessions
        </legend>

        {options.map((option) => {
          const selected = option.kind === kind;
          const target =
            option.kind === "through_final" ? exams.at(-1) : exams.at(0);

          return (
            <button
              key={option.kind}
              type="button"
              onClick={() => setKind(option.kind)}
              aria-pressed={selected}
              className={`rounded-2xl border p-4 text-left transition-colors sm:p-5 ${
                selected
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-surface hover:bg-surface-sunken"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {option.sessions} sessions
                  {option.kind === "through_final" ? " — through the final" : ""}
                </span>
                <Money minor={option.priceMinor} className="font-semibold" />
              </div>
              <p className="pt-1 text-sm text-muted">
                <Money minor={option.perSessionMinor} /> a session
                {option.savingsMinor > 0 ? (
                  <>
                    {" · saves "}
                    <Money minor={option.savingsMinor} />
                  </>
                ) : null}
                {target ? ` · ready for ${target.name}, ${formatDay(target.occursOn)}` : ""}
              </p>
            </button>
          );
        })}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          Your first session with {tutorName}
        </legend>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visibleSlots.map((value) => {
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

        {slots.length > visibleSlots.length ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowAllSlots(true)}
          >
            Show all {slots.length} times
          </Button>
        ) : null}
      </fieldset>

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" disabled={pending || slot === ""}>
          {pending ? "Booking…" : "Pay and book"}
        </Button>
        <p className="text-center text-xs text-muted">
          Your first session is covered by a refund guarantee, self-serve, no
          questions. Sessions you do not use refund at the end of term.
        </p>
      </div>
    </form>
  );
}
