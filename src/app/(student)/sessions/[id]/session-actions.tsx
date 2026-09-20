"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Field, Textarea } from "@/components/field";
import type { ViewerAction } from "@/server/modules/engagements/attendance";

import { cancel, confirm, deny, type ActionResult } from "../../actions";

/**
 * The one thing this student can do about this session, rendered from
 * `viewerAction`.
 *
 * The discriminator is computed by a pure function on the server so the
 * student view and the tutor view cannot drift apart. Re-deriving it here from
 * six nullable timestamps is exactly the drift that function exists to
 * prevent, so this file switches on it and adds nothing.
 */
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
          {/*
            Say which way each person answered. "You answered differently"
            leaves the student guessing what the disagreement even is, and the
            two answers are timestamped facts — the same facts the reviewer
            works from.

            `denialNote` is deliberately not rendered here. It is one party's
            written account, kept for whoever settles this, and putting the
            other side's version of events in front of someone turns a
            disagreement into a fight. The student can say their piece to the
            reviewer; they do not need to read the accusation first.
          */}
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

/* -------------------------------------------------------------------------- */
/* cancelling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A late cancel writes a timestamped fact, so it is disclosed before the
 * button that writes it — never after, and never in small print. The second
 * half of the disclosure matters as much as the first: it costs nothing, the
 * session comes back, and attending the next ones clears it. A consequence
 * that looks permanent is a punishment, and this system does not have those.
 */
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

/* -------------------------------------------------------------------------- */
/* confirming                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Both parties answer, and the question is deliberately about the session
 * rather than about the tutor: "did this happen", not "how was it". There is
 * no rating here and there is not going to be one.
 */
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
          {/*
            `maxLength` mirrors what `denyAttendanceInput` accepts, so the limit
            turns up at the keyboard rather than as a rejection after someone
            has written their account of a session that did not happen.
          */}
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
