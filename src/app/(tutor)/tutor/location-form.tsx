"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Field, Input } from "@/components/field";

export type LocationState =
  | { status: "idle" }
  | { status: "saved"; message: string }
  | { status: "error"; message: string };

type LocationAction = (previous: LocationState, formData: FormData) => Promise<LocationState>;

const INITIAL: LocationState = { status: "idle" };

export function LocationForm({
  action,
  current,
  label,
  hint,
  sessionId,
  collapsed = false,
}: {
  action: LocationAction;
  current: string | null;
  label: string;
  hint?: string;
  sessionId?: string;
  collapsed?: boolean;
}) {
  const [state, submit, pending] = useActionState(action, INITIAL);
  const [openedFrom, setOpenedFrom] = useState<LocationState | null>(null);
  const id = useId();

  const open =
    !collapsed ||
    (openedFrom !== null && (openedFrom === state || state.status === "error"));

  if (!open) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button type="button" variant="ghost" onClick={() => setOpenedFrom(state)}>
          {current ? "Change the spot for this session" : "Set the spot for this session"}
        </Button>
        {state.status === "saved" ? (
          <p role="status" className="text-sm text-accent">
            {state.message}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      {sessionId ? <input type="hidden" name="sessionId" value={sessionId} /> : null}

      <Field
        id={id}
        label={label}
        hint={hint}
        error={state.status === "error" ? state.message : undefined}
      >
        <Input
          id={id}
          name="location"
          required
          maxLength={200}
          defaultValue={current ?? ""}
          placeholder="Gorgas Library, 2nd floor study rooms"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {collapsed ? (
          <Button type="button" variant="ghost" onClick={() => setOpenedFrom(null)} disabled={pending}>
            Keep it
          </Button>
        ) : null}
        {state.status === "saved" && !collapsed ? (
          <p role="status" className="text-sm text-accent">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
