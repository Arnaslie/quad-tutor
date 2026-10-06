"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Select, Textarea } from "@/components/field";
import {
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
} from "@/server/modules/messaging/rules";

import type { MessageActionState } from "../actions";

const INITIAL: MessageActionState = { status: "idle" };

export function ReportForm({
  action,
  field,
  value,
  label,
  hint,
  sent,
}: {
  action: (previous: MessageActionState, formData: FormData) => Promise<MessageActionState>;
  field: string;
  value: string;
  label: string;
  hint: string;
  sent: string;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  const reasonId = useId();
  const noteId = useId();

  if (state.status === "sent") {
    return (
      <p role="status" className="text-sm text-accent">
        {sent}
      </p>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name={field} value={value} />
      <Field
        id={reasonId}
        label={label}
        hint={hint}
        error={state.status === "error" ? state.message : undefined}
      >
        <Select id={reasonId} name="reason" defaultValue="" required>
          <option value="" disabled>
            Pick a reason
          </option>
          {REPORT_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {REPORT_REASON_LABEL[reason]}
            </option>
          ))}
        </Select>
      </Field>
      <Field id={noteId} label="Anything we should know" hint="Optional.">
        <Textarea id={noteId} name="note" maxLength={REPORT_NOTE_MAX_LENGTH} />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Reporting…" : "Report"}
      </Button>
    </form>
  );
}
