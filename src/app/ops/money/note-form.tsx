"use client";

import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";

import { Button, type ButtonVariant } from "@/components/button";
import { Field, Textarea } from "@/components/field";

import type { MoneyFormState } from "./actions";

export type NoteChoice = {
  action: (previous: MoneyFormState, formData: FormData) => Promise<MoneyFormState>;
  label: string;
  pending: string;
  variant?: ButtonVariant;
};

/** One note, one submit per write; the pressed button picks which action runs. */
export function NoteForm({ id, hint, choices }: { id: string; hint: string; choices: NoteChoice[] }) {
  const [state, submit] = useActionState(
    (previous: MoneyFormState, formData: FormData) => choices[Number(formData.get("choice"))].action(previous, formData),
    null,
  );
  const noteId = useId();

  return (
    <form action={submit} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={id} />
      <Field id={noteId} label="Note" hint={hint} error={state?.error}>
        <Textarea
          id={noteId}
          name="note"
          required
          minLength={3}
          maxLength={500}
          defaultValue={state?.note}
          invalid={Boolean(state?.error)}
        />
      </Field>
      <Submits choices={choices} />
    </form>
  );
}

function Submits({ choices }: { choices: NoteChoice[] }) {
  const { pending, data } = useFormStatus();
  const pressed = data?.get("choice");

  return (
    <div className="grid gap-2">
      {choices.map((choice, index) => (
        <Button key={choice.label} type="submit" name="choice" value={index} variant={choice.variant} disabled={pending}>
          {pending && pressed === String(index) ? choice.pending : choice.label}
        </Button>
      ))}
    </div>
  );
}
