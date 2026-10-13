"use client";

import { useActionState, useState } from "react";

import { Button, type ButtonVariant } from "@/components/button";
import type { ReversalAnswer } from "@/server/modules/billing/ops";

import { answerReversalAction, type MoneyFormState } from "./actions";

const ANSWERS: Record<ReversalAnswer, { title: string; body: string; submit: string; pending: string; variant: ButtonVariant }> = {
  resend: {
    title: "Send it again",
    body: "A new transfer of this amount goes to the tutor's Stripe account now, or as soon as their account can take it.",
    submit: "Send it again",
    pending: "Sending…",
    variant: "primary",
  },
  manual: {
    title: "Paid another way",
    body: "You paid the tutor outside Stripe. Nothing is sent, and it counts as paid.",
    submit: "Record the payment",
    pending: "Recording…",
    variant: "primary",
  },
  forfeited: {
    title: "Write it off",
    body: "The tutor does not get this money. Nothing is sent, now or later.",
    submit: "Write it off",
    pending: "Writing off…",
    variant: "danger",
  },
};

export function ReversalForm({ id, paused }: { id: string; paused: boolean }) {
  const [state, submit, pending] = useActionState(answerReversalAction, null as MoneyFormState);
  const [answer, setAnswer] = useState<ReversalAnswer | null>(null);
  const picked = answer ? ANSWERS[answer] : null;

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium text-foreground">What should happen to this money?</legend>
        {(Object.keys(ANSWERS) as ReversalAnswer[]).map((key) => {
          const blocked = paused && key === "resend";
          return (
            <label
              key={key}
              className={`flex min-h-11 items-start gap-3 rounded-xl border p-3.5 ${
                blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${answer === key ? "border-accent bg-accent-soft" : "border-border"}`}
            >
              <input
                type="radio"
                name="answer"
                value={key}
                checked={answer === key}
                disabled={blocked}
                onChange={() => setAnswer(key)}
                className="mt-1 accent-accent"
              />
              <span className="flex flex-col gap-1">
                <span className="text-sm font-medium text-foreground">{ANSWERS[key].title}</span>
                <span className="text-sm text-muted">
                  {blocked ? "Waits until the pause on this package is lifted. The other two work now." : ANSWERS[key].body}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {state?.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant={picked?.variant} disabled={!picked || pending}>
        {picked ? (pending ? picked.pending : picked.submit) : "Pick an answer"}
      </Button>
    </form>
  );
}
