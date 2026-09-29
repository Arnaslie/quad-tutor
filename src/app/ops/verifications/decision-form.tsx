"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/button";
import { Field, Select } from "@/components/field";
import {
  REJECTION_REASONS,
  REJECTION_REASON_LABEL,
} from "@/server/modules/tutoring/proof-rules";

import { decideClaimAction, type DecisionState } from "./actions";

const INITIAL: DecisionState = { status: "idle" };

export function DecisionForm({ tutorCourseId }: { tutorCourseId: string }) {
  const [state, submit] = useActionState(decideClaimAction, INITIAL);
  const reasonId = useId();

  return (
    <form action={submit} className="flex flex-col gap-4">
      <input type="hidden" name="tutorCourseId" value={tutorCourseId} />
      <Field
        id={reasonId}
        label="If it doesn't check out"
        error={state.status === "error" ? state.message : undefined}
      >
        <Select id={reasonId} name="reason" defaultValue="">
          <option value="">Pick a reason</option>
          {REJECTION_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {REJECTION_REASON_LABEL[reason]}
            </option>
          ))}
        </Select>
      </Field>
      <Choices />
    </form>
  );
}

function Choices() {
  const { pending, data } = useFormStatus();
  const intent = data?.get("intent");

  return (
    <div className="grid grid-cols-2 gap-3">
      <Button type="submit" name="intent" value="approve" disabled={pending}>
        {pending && intent === "approve" ? "Approving…" : "Approve"}
      </Button>
      <Button type="submit" name="intent" value="reject" variant="secondary" disabled={pending}>
        {pending && intent === "reject" ? "Sending back…" : "Send back"}
      </Button>
    </div>
  );
}
