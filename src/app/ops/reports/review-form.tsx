"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Select } from "@/components/field";
import { REPORT_OUTCOME_LABEL, outcomesFor, type ReportSubject } from "@/server/modules/messaging/rules";

import { reviewReportAction, type ReviewState } from "./actions";

const INITIAL: ReviewState = { status: "idle" };

export function ReviewForm({ reportId, subject }: { reportId: string; subject: ReportSubject }) {
  const [state, submit, pending] = useActionState(reviewReportAction, INITIAL);
  const id = useId();

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="reportId" value={reportId} />
      <Field id={id} label="Outcome" error={state.status === "error" ? state.message : undefined}>
        <Select id={id} name="outcome" defaultValue="" required>
          <option value="" disabled>
            Pick an outcome
          </option>
          {outcomesFor(subject).map((outcome) => (
            <option key={outcome} value={outcome}>
              {REPORT_OUTCOME_LABEL[outcome]}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Mark reviewed"}
      </Button>
    </form>
  );
}
