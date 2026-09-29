"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Textarea } from "@/components/field";
import { MESSAGE_MAX_LENGTH } from "@/server/modules/messaging/rules";

import { sendAction, type MessageActionState } from "../actions";

const INITIAL: MessageActionState = { status: "idle" };

export function Composer({ threadId }: { threadId: string }) {
  const [state, submit, pending] = useActionState(sendAction, INITIAL);
  const id = useId();

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="threadId" value={threadId} />
      <Field
        id={id}
        label="Message"
        hint="If either of you reports this conversation, Quad Tutor staff can read it."
        error={state.status === "error" ? state.message : undefined}
      >
        <Textarea
          id={id}
          name="body"
          required
          maxLength={MESSAGE_MAX_LENGTH}
          defaultValue={state.status === "error" ? state.draft : ""}
          invalid={state.status === "error"}
        />
      </Field>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Sending…" : "Send"}
      </Button>
    </form>
  );
}
