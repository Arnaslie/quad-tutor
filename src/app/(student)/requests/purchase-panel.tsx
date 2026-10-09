"use client";

import { useActionState, useState } from "react";

import { Button, ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDay, formatTime } from "@/components/format";
import type {
  PackageKind,
  PackageOption,
  RequestedKind,
} from "@/server/modules/billing/pricing";

import { purchase, type ActionResult } from "../actions";
import { MeetingSpot, StudentNoteField } from "../meeting-spot";
import { PackageChoice } from "../package-choice";

export type ExamChoice = {
  id: string;
  name: string;

  occursOn: string;
};

export function PurchasePanel({
  requestId,
  tutorName,
  location,
  slots,
  exams,
  options,
  requestedKind,
}: {
  requestId: string;
  tutorName: string;
  location: string | null;
  slots: string[];
  exams: ExamChoice[];
  options: PackageOption[];
  requestedKind: RequestedKind | null;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    purchase,
    null,
  );
  const [kind, setKind] = useState<PackageKind>(requestedKind ?? "exam_anchored");
  const [slot, setSlot] = useState<string>(slots.at(0) ?? "");
  const [showAllSlots, setShowAllSlots] = useState(false);

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
      {requestedKind ? null : <input type="hidden" name="kind" value={kind} />}
      <input type="hidden" name="anchorExamId" value={anchor?.id ?? ""} />
      <input type="hidden" name="slotStartsAt" value={slot} />

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-semibold uppercase tracking-wide text-muted">
          {requestedKind ? "The package you asked for" : "How many sessions"}
        </legend>

        {options
          .filter((option) => !requestedKind || option.kind === requestedKind)
          .map((option) => {
            const target =
              option.kind === "through_final" ? exams.at(-1) : exams.at(0);

            return (
              <PackageChoice
                key={option.kind}
                option={option}
                selected={option.kind === kind}
                onSelect={requestedKind ? undefined : () => setKind(option.kind)}
                extra={
                  target ? ` · ready for ${target.name}, ${formatDay(target.occursOn)}` : ""
                }
              />
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

      <MeetingSpot tutorName={tutorName} location={location} />

      <StudentNoteField tutorName={tutorName} />

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <Button type="submit" size="lg" disabled={pending || slot === ""}>
          {pending ? "Opening checkout…" : "Pay and book"}
        </Button>
        <p className="text-center text-xs text-muted">
          Sessions you do not use are refunded at the end of term, or when you end
          the package.
        </p>
      </div>
    </form>
  );
}
