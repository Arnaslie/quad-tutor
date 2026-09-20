"use client";

import { useActionState } from "react";

import { Button, ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { Icon } from "@/components/icons";

import { notifyWhenCovered, type ActionResult } from "../../actions";

/**
 * Zero tutors is a demand-capture moment, not an error page.
 *
 * Two things this screen must not do: apologise, and imply the student did
 * something wrong by picking an uncovered course. What it does instead is say
 * plainly what is true — nobody has claimed this course yet, not just this
 * section — and take the one useful action available, which is to record who
 * is waiting.
 */
export function DemandCapture({
  offeringId,
  courseCode,
  courseTitle,
  professorName,
}: {
  offeringId: string;
  courseCode: string;
  courseTitle: string;
  professorName: string | null;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    notifyWhenCovered,
    null,
  );

  const done = state?.ok === true;

  return (
    <Card className="flex flex-col items-center gap-4 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-surface-sunken text-muted">
        <Icon name="cap" />
      </span>

      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-medium">
          Nobody tutors {courseCode} yet
        </h2>
        <p className="max-w-sm text-sm text-muted">
          Not this section and not the others — no one has taken {courseTitle}
          {professorName ? ` under ${professorName}` : ""} and signed up to tutor
          it. We would rather tell you that than show you someone who has not.
        </p>
      </div>

      {done ? (
        <p className="text-sm text-accent" role="status">
          You are on the list. We will tell you the day someone covers this
          section.
        </p>
      ) : (
        <form action={action} className="flex w-full max-w-xs flex-col gap-2">
          <input type="hidden" name="offeringId" value={offeringId} />
          {state && !state.ok ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? "Saving…" : "Tell me when someone covers it"}
          </Button>
        </form>
      )}

      <ButtonLink href="/courses" variant="ghost">
        Pick another course
      </ButtonLink>
    </Card>
  );
}
