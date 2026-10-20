"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Field, Textarea } from "@/components/field";
import { Money } from "@/components/money";
import {
  answerCopy,
  deliveredIfUnanswered,
  lapseCopy,
} from "@/server/modules/engagements/answer-outcome";
import { isLateCancel, type ViewerAction } from "@/server/modules/engagements/attendance";
import { cancelRefundsCard, cancelSplit, hoursBefore } from "@/server/modules/engagements/cancel-rules";

import { cancel, confirm, deny, type ActionResult } from "../../actions";

type CancelPrice = {
  scheduledAt: Date;
  sessionMinor: number;
  currency: string;
  sessionsPurchased: number;
};

export function SessionActions({
  sessionId,
  action,
  otherPartyName,
  yourAnswer,
  theirAnswer,
  price,
}: {
  sessionId: string;
  action: ViewerAction;
  otherPartyName: string;
  yourAnswer: "confirmed" | "denied" | null;
  theirAnswer: "confirmed" | "denied" | null;
  price: CancelPrice;
}) {
  switch (action) {
    case "cancel":
    case "late_cancel":
      return <Cancel sessionId={sessionId} otherPartyName={otherPartyName} price={price} />;
    case "confirm_or_deny":
      return <Answer sessionId={sessionId} otherPartyName={otherPartyName} />;
    case "awaiting_other_party":
      return (
        <Note>
          You said this{" "}
          {yourAnswer === "denied" ? "did not happen" : "happened"}. Waiting on{" "}
          {otherPartyName}. If they say nothing within a day,{" "}
          {lapseCopy(
            deliveredIfUnanswered({ student: yourAnswer, tutor: theirAnswer }),
            "your",
          )}
          . We will email you when it settles.
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

function Cancel({
  sessionId,
  otherPartyName,
  price,
}: {
  sessionId: string;
  otherPartyName: string;
  price: CancelPrice;
}) {
  const [split, setSplit] = useState<(ReturnType<typeof cancelSplit> & { toCard: boolean; late: boolean }) | null>(null);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await cancel(previous, formData);
      if (!result.ok && result.requote) setSplit(result.requote);
      return result;
    },
    null,
  );

  if (state?.ok) return <Result state={state} />;

  if (!split) {
    return (
      <div className="flex flex-col gap-2">
        <Result state={state} />
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const now = new Date();
            const hours = hoursBefore(price.scheduledAt, now);
            setSplit({
              ...cancelSplit(price.sessionMinor, hours, "student"),
              toCard: cancelRefundsCard(price.sessionsPurchased, hours, "student"),
              late: isLateCancel(price.scheduledAt, now),
            });
          }}
        >
          Cancel this session
        </Button>
      </div>
    );
  }

  const money = (minor: number) => <Money minor={minor} currency={price.currency} />;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="shownKeptMinor" value={split.keptMinor} />

      <Card className="flex flex-col gap-2 text-sm">
        {split.keptMinor > 0 ? (
          <>
            <p className="font-medium">
              Cancel now and you get {money(split.returnedMinor)} back.{" "}
              {money(split.keptMinor)} goes to {otherPartyName}.
            </p>
            <p className="text-muted">
              It goes back to your card now, and can take 5 to 10 days to show.
              The session counts as used.
            </p>
          </>
        ) : split.toCard ? (
          <>
            <p className="font-medium">
              Cancel now and you get all {money(split.returnedMinor)} back.
            </p>
            <p className="text-muted">
              It goes back to your card now, and can take 5 to 10 days to show.
            </p>
          </>
        ) : (
          <p className="text-muted">
            Cancel now and the session goes back in your package. You can book
            another time. Nothing is charged.
          </p>
        )}
        {split.late ? (
          <p className="text-muted">
            Inside 12 hours it is also recorded as a late cancel, which is a fact
            about the timing and nothing else. Your next few attended sessions
            clear it.
          </p>
        ) : null}
      </Card>

      <Result state={state} />

      <div className="flex gap-2">
        <Button type="submit" variant="danger" className="flex-1" disabled={pending}>
          {pending ? "Cancelling…" : split.keptMinor > 0 ? "Cancel anyway" : "Cancel it"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex-1"
          onClick={() => setSplit(null)}
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

  const answered = (confirmState?.ok && confirmState.answered) || (denyState?.ok && denyState.answered);
  if (answered) {
    return (
      <p role="status" className="text-sm text-accent">
        {answerCopy({ ...answered, viewer: "student", otherPartyName })}
      </p>
    );
  }

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
