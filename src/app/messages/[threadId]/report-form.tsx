"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Select, Textarea } from "@/components/field";
import {
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
} from "@/server/modules/messaging/rules";

import { reportAction, type MessageActionState } from "../actions";

const INITIAL: MessageActionState = { status: "idle" };

export function ReportForm({ threadId }: { threadId: string }) {
  const [state, submit, pending] = useActionState(reportAction, INITIAL);
  const reasonId = useId();
  const noteId = useId();

  if (state.status === "sent") {
    return (
      <p role="status" className="text-sm text-accent">
        Reported. Someone on the Quad Tutor team will read this conversation.
      </p>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="threadId" value={threadId} />
      <Field
        id={reasonId}
        label="Report this conversation"
        hint="Staff can read a conversation only once it is reported."
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
