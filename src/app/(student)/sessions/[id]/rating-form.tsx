"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/button";
import { Field, Textarea } from "@/components/field";
import { Icon } from "@/components/icons";
import { NOTE_MAX, STARS } from "@/server/modules/ratings/rules";

import { rate, type ActionResult } from "../../actions";

export function RatingForm({
  sessionId,
  rating,
}: {
  sessionId: string;
  rating: { stars: number; note: string | null } | null;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(rate, null);
  const [stars, setStars] = useState(rating?.stars ?? 0);
  const [note, setNote] = useState(rating?.note ?? "");
  const noteId = useId();

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="sessionId" value={sessionId} />

      <fieldset className="flex flex-col">
        <legend className="pb-1.5 text-sm font-medium">How was it?</legend>
        <div className="flex gap-1">
          {STARS.map((value) => (
            <label
              key={value}
              className="cursor-pointer rounded-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent"
            >
              <input
                type="radio"
                name="stars"
                value={value}
                checked={value === stars}
                onChange={() => setStars(value)}
                className="sr-only"
                required
              />
              <span className="sr-only">
                {value} {value === 1 ? "star" : "stars"}
              </span>
              <Icon
                name="star"
                className={`size-11 p-1.5 ${value <= stars ? "fill-current text-accent" : "text-muted"}`}
              />
            </label>
          ))}
        </div>
      </fieldset>

      <Field
        id={noteId}
        label="Anything to add? (optional)"
        hint={`${note.length} / ${NOTE_MAX}. Your tutor sees notes later, grouped with others, without your name.`}
      >
        <Textarea
          id={noteId}
          name="note"
          maxLength={NOTE_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      {state ? (
        <p role={state.ok ? "status" : "alert"} className={`text-sm ${state.ok ? "text-accent" : "text-danger"}`}>
          {state.ok ? state.message : state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : rating ? "Update rating" : "Save rating"}
      </Button>
    </form>
  );
}
