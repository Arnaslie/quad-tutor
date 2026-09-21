"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Field, Textarea } from "@/components/field";
import type { ViewerAction } from "@/server/modules/engagements/attendance";

import { cancel, confirm, deny, type ActionResult } from "../../actions";

export function SessionActions({
  sessionId,
  action,
  otherPartyName,
  yourAnswer,
  theirAnswer,
}: {
  sessionId: string;
  action: ViewerAction;
  otherPartyName: string;
  yourAnswer: "confirmed" | "denied" | null;
  theirAnswer: "confirmed" | "denied" | null;
}) {
  switch (action) {
    case "cancel":
      return <Cancel sessionId={sessionId} late={false} />;
    case "late_cancel":
      return <Cancel sessionId={sessionId} late />;
    case "confirm_or_deny":
      return <Answer sessionId={sessionId} otherPartyName={otherPartyName} />;
    case "awaiting_other_party":
      return (
        <Note>
          You said this{" "}
          {yourAnswer === "denied" ? "did not happen" : "happened"}. Waiting on{" "}
          {otherPartyName}. If they say nothing within a day, it settles as
          attended.
        </Note>
      );
    case "awaiting_review":
      return (
        <Note>

          {yourAnswer && theirAnswer ? (
            <p>
              You said it {yourAnswer === "denied" ? "did not happen" : "happened"}.{" "}
              {otherPartyName} said it {theirAnswer === "denied" ? "did not" : "did"}.
            </p>
          ) : (
            <p>You and {otherPartyName} answered differently.</p>
          )}
          <p className="pt-2">
            A person settles this one — no automatic sweep will. No money moves
            while it is open, and nothing is recorded against either of you
            until it is.
          </p>
        </Note>
      );
    case "none":
      return null;
  }
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Card className="bg-surface-sunken text-sm text-muted">{children}</Card>
  );
}

function Result({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return state.ok ? (
    <p role="status" className="text-sm text-accent">
      {state.message}
    </p>
  ) : (
    <p role="alert" className="text-sm text-danger">
      {state.error}
    </p>
  );
}

function Cancel({ sessionId, late }: { sessionId: string; late: boolean }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    cancel,
    null,
  );
  const [armed, setArmed] = useState(false);

  if (state?.ok) return <Result state={state} />;

  if (!armed) {
    return (
      <div className="flex flex-col gap-2">
        <Result state={state} />
        <Button type="button" variant="secondary" onClick={() => setArmed(true)}>
          Cancel this session
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="sessionId" value={sessionId} />

      <Card className="flex flex-col gap-2 text-sm">
        {late ? (
          <>
            <p className="font-medium">This is inside 12 hours.</p>
            <p className="text-muted">
              It is recorded as a late cancel, which is a fact about the timing
              and nothing else. It costs you no money and the session goes back
              into your package. Your next few attended sessions clear it.
            </p>
          </>
        ) : (
          <p className="text-muted">
            The session goes back into your package and you can book it again for
            another time. Nothing is charged either way.
          </p>
        )}
      </Card>

      <Result state={state} />

      <div className="flex gap-2">
        <Button type="submit" variant="danger" className="flex-1" disabled={pending}>
          {pending ? "Cancelling…" : late ? "Cancel anyway" : "Cancel it"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex-1"
          onClick={() => setArmed(false)}
          disabled={pending}
        >
          Keep it
        </Button>
      </div>
    </form>
  );
}

function Answer({
  sessionId,
  otherPartyName,
}: {
  sessionId: string;
  otherPartyName: string;
}) {
  const [confirmState, confirmAction, confirming] = useActionState<
    ActionResult | null,
    FormData
  >(confirm, null);
  const [denyState, denyAction, denying] = useActionState<
    ActionResult | null,
    FormData
  >(deny, null);
  const [disputing, setDisputing] = useState(false);
  const noteId = useId();

  if (confirmState?.ok) return <Result state={confirmState} />;
  if (denyState?.ok) return <Result state={denyState} />;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Did this session happen? {otherPartyName} is answering the same question.
      </p>

      {disputing ? (
        <form action={denyAction} className="flex flex-col gap-3">
          <input type="hidden" name="sessionId" value={sessionId} />

          <Field
            id={noteId}
            label="What happened? (optional)"
            hint={`Only read by whoever settles it if ${otherPartyName} says something different.`}
          >
            <Textarea
              id={noteId}
              name="note"
              maxLength={500}
              placeholder="They never showed up."
            />
          </Field>

          <Result state={denyState} />

          <div className="flex gap-2">
            <Button type="submit" variant="danger" className="flex-1" disabled={denying}>
              {denying ? "Sending…" : "It did not happen"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="flex-1"
              onClick={() => setDisputing(false)}
              disabled={denying}
            >
              Back
            </Button>
          </div>
        </form>
      ) : (
        <>
          <Result state={confirmState} />
          <form action={confirmAction} className="flex flex-col gap-2">
            <input type="hidden" name="sessionId" value={sessionId} />
            <Button type="submit" size="lg" disabled={confirming}>
              {confirming ? "Saving…" : "Yes, it happened"}
            </Button>
          </form>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setDisputing(true)}
            disabled={confirming}
          >
            No, it did not
          </Button>
        </>
      )}
    </div>
  );
}
