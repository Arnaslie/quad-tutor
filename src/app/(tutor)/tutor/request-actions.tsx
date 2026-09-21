"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/button";
import { Icon } from "@/components/icons";

import { respondToRequest, type RespondState } from "./actions";

const INITIAL: RespondState = { status: "idle" };

export function RequestActions({
  requestId,
  studentName,
}: {
  requestId: string;
  studentName: string;
}) {
  const [state, submit] = useActionState(respondToRequest, INITIAL);

  if (state.status !== "idle") {
    return <Outcome state={state} studentName={studentName} />;
  }

  return (
    <form action={submit}>
      <input type="hidden" name="requestId" value={requestId} />
      <Choices />
    </form>
  );
}

function Choices() {
  const { pending, data } = useFormStatus();
  const intent = data?.get("intent");

  return (
    <div className="grid grid-cols-2 gap-3">
      <Button type="submit" name="intent" value="accept" size="lg" disabled={pending}>
        {pending && intent === "accept" ? "Accepting…" : "Accept"}
      </Button>
      <Button
        type="submit"
        name="intent"
        value="pass"
        variant="secondary"
        size="lg"
        disabled={pending}
      >
        {pending && intent === "pass" ? "Passing…" : "Pass"}
      </Button>
    </div>
  );
}

function Outcome({ state, studentName }: { state: RespondState; studentName: string }) {
  if (state.status === "accepted") {
    return (
      <p className="flex items-start gap-2 text-sm text-foreground" role="status">
        <Icon name="check" className="mt-0.5 size-[18px] shrink-0 text-accent" />
        <span>
          Accepted. {studentName} picks a time from your hours and pays — it shows up
          under Sessions once they do.
        </span>
      </p>
    );
  }

  if (state.status === "passed") {
    return (
      <p className="text-sm text-muted" role="status">
        Passed. That costs you nothing.
      </p>
    );
  }

  return (
    <p className="text-sm text-muted" role="status">
      {state.status === "gone" ? state.message : null}
    </p>
  );
}
