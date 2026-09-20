"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Field, Textarea } from "@/components/field";

import {
  answerSession,
  cancelTutorSession,
  type SessionActionState,
} from "./actions";

const INITIAL: SessionActionState = { status: "idle" };

/**
 * The one thing this tutor can do about this session, taken from
 * `viewerAction` on the server. The rules are not re-derived here — six
 * nullable timestamps interpreted twice is how the two surfaces drift apart.
 *
 * Only the two interactive outcomes reach the client; everything else is
 * static copy rendered by the page.
 */
export function SessionActions({
  sessionId,
  studentName,
  action,
}: {
  sessionId: string;
  studentName: string;
  action: "confirm_or_deny" | "cancel" | "late_cancel";
}) {
  if (action === "confirm_or_deny") {
    return <Answer sessionId={sessionId} studentName={studentName} />;
  }

  return (
    <Cancel
      sessionId={sessionId}
      studentName={studentName}
      late={action === "late_cancel"}
    />
  );
}

function Answer({ sessionId, studentName }: { sessionId: string; studentName: string }) {
  const [state, submit, pending] = useActionState(answerSession, INITIAL);
  const [reporting, setReporting] = useState(false);
  const noteId = useId();

  if (state.status !== "idle") {
    return <Outcome state={state} studentName={studentName} />;
  }

  if (reporting) {
    return (
      <form action={submit} className="flex flex-col gap-3">
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="intent" value="deny" />

        {/* The asymmetry, said out loud. A tutor's denial means one specific
            thing, and a tutor who could not make it has a different button. */}
        <p className="text-sm text-muted">
          You are reporting that <span className="text-foreground">{studentName}</span>{" "}
          did not show up. If you were the one who could not make it, go back and
          cancel instead.
        </p>

        <Field
          id={noteId}
          label="Anything a reviewer should know (optional)"
          hint="Only read if the two of you answer differently."
        >
          <Textarea
            id={noteId}
            name="note"
            maxLength={500}
            placeholder="Waited 20 minutes, no message."
          />
        </Field>

        <div className="flex flex-col gap-3 sm:grid sm:grid-cols-2">
          <Button type="submit" variant="danger" size="lg" disabled={pending}>
            {pending ? "Reporting…" : "Report no-show"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            onClick={() => setReporting(false)}
            disabled={pending}
          >
            Back
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">Did this session happen?</p>
      <form action={submit} className="flex flex-col gap-3 sm:grid sm:grid-cols-2">
        <input type="hidden" name="sessionId" value={sessionId} />
        <Button
          type="submit"
          name="intent"
          value="confirm"
          size="lg"
          disabled={pending}
        >
          {pending ? "Confirming…" : "It happened"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => setReporting(true)}
          disabled={pending}
        >
          They did not show
        </Button>
      </form>
    </div>
  );
}

function Cancel({
  sessionId,
  studentName,
  late,
}: {
  sessionId: string;
  studentName: string;
  late: boolean;
}) {
  const [state, submit, pending] = useActionState(cancelTutorSession, INITIAL);
  const [confirming, setConfirming] = useState(false);

  if (state.status !== "idle") {
    return <Outcome state={state} studentName={studentName} />;
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" size="lg" onClick={() => setConfirming(true)}>
          Cancel this session
        </Button>
        {late ? (
          <p className="text-sm text-muted">
            This is inside 12 hours, so it is recorded as a late cancel.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="sessionId" value={sessionId} />
      <p className="text-sm text-muted">
        The session goes back to {studentName}&rsquo;s package and they can book
        another time.
      </p>
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-2">
        <Button type="submit" variant="danger" size="lg" disabled={pending}>
          {pending ? "Cancelling…" : "Yes, cancel"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Keep it
        </Button>
      </div>
    </form>
  );
}

function Outcome({
  state,
  studentName,
}: {
  state: SessionActionState;
  studentName: string;
}) {
  return (
    <p className="text-sm text-muted" role="status">
      {copy(state, studentName)}
    </p>
  );
}

function copy(state: SessionActionState, studentName: string): string | null {
  switch (state.status) {
    case "idle":
      return null;

    case "cancelled":
      return state.late
        ? `Cancelled, and recorded as a late cancel. ${studentName} can book another time.`
        : `Cancelled. ${studentName} can book another time.`;

    case "error":
      return state.message;

    case "answered":
      switch (state.outcome) {
        case "attended":
          // Both said yes: this is the one case attendance is a fact with two
          // names on it. It is also the moment the session becomes earned.
          return "Confirmed by both of you. This session is delivered and earned.";
        case "not_attended":
          return `You both said it did not happen. The session goes back to ${studentName}'s package.`;
        case "disputed":
          return `You and ${studentName} gave different answers. Nothing moves until someone reviews it.`;
        case "awaiting_other":
          return state.answer === "confirmed"
            ? `Confirmed. Waiting on ${studentName} to answer.`
            : `Reported. Waiting on ${studentName} to answer.`;
      }
  }
}
