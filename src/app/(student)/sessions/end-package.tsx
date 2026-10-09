"use client";

import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { formatDayTime } from "@/components/format";
import { Money } from "@/components/money";

import { endEarly, type ActionResult } from "../actions";

const EndedContext = createContext<(message: string) => void>(() => {});

export function EndedNotice({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: "nearest" });
  }, [message]);

  return (
    <EndedContext value={setMessage}>
      {message ? (
        <div ref={ref} role="status" className="scroll-mt-24">
          <Card className="bg-accent-soft text-sm text-accent">{message}</Card>
        </div>
      ) : null}
      {children}
    </EndedContext>
  );
}

export function EndPackage({
  engagementId,
  tutorName,
  refundMinor,
  currency,
  delivered,
  cancels,
}: {
  engagementId: string;
  tutorName: string;
  refundMinor: number;
  currency: string;
  delivered: number;
  cancels: string[];
}) {
  const onEnded = useContext(EndedContext);
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await endEarly(previous, formData);
      if (result.ok) onEnded(result.message ?? "Package ended.");
      return result;
    },
    null,
  );

  if (!open) {
    return (
      <Button type="button" variant="ghost" className="-ml-4" onClick={() => setOpen(true)}>
        End this package
      </Button>
    );
  }

  return (
    <form
      action={action}
      className="flex w-full flex-col gap-3 border-t border-border pt-3 text-sm"
    >
      <input type="hidden" name="engagementId" value={engagementId} />

      <p className="font-medium">
        {refundMinor > 0 ? (
          <>
            You get <Money minor={refundMinor} currency={currency} /> back for the
            sessions you have not had.
          </>
        ) : (
          "Nothing is left to refund."
        )}
      </p>

      {delivered > 0 ? (
        <p className="text-muted">
          {delivered === 1
            ? "The session you already had stays paid."
            : `The ${delivered} sessions you already had stay paid.`}
        </p>
      ) : null}

      {cancels.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted">
            Ending cancels {cancels.length === 1 ? "this session" : "these sessions"}, and{" "}
            {tutorName} is told:
          </p>
          <ul className="flex flex-col gap-1">
            {cancels.map((when) => (
              <li key={when}>{formatDayTime(when)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-muted">You cannot undo this.</p>

      {state && !state.ok ? (
        <p role="alert" className="text-danger">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? "Ending…" : "End package"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => setOpen(false)}
        >
          Keep it
        </Button>
      </div>
    </form>
  );
}
