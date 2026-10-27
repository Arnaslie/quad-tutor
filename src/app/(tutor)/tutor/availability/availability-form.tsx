"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Select } from "@/components/field";

import { addAvailabilityAction, type AvailabilityState } from "./actions";
import { WEEKDAYS } from "./time";
import { TimePicker } from "./time-picker";

const INITIAL: AvailabilityState = { status: "idle" };

const DEFAULTS = { weekday: 1, startMinute: 18 * 60, endMinute: 21 * 60 };

export function AvailabilityForm() {
  const [state, submit, pending] = useActionState(addAvailabilityAction, INITIAL);
  const dayId = useId();
  const { weekday, startMinute, endMinute } = (state.status === "error" && state.picked) || DEFAULTS;
  const key = `${weekday}-${startMinute}-${endMinute}`;

  return (
    <form action={submit} className="flex flex-col gap-4">
      <Field id={dayId} label="Day">
        <Select key={key} id={dayId} name="weekday" defaultValue={weekday}>
          {WEEKDAYS.map((day, index) => (
            <option key={day} value={index}>
              {day}
            </option>
          ))}
        </Select>
      </Field>

      <TimePicker key={`start-${key}`} label="From" name="start" defaultMinute={startMinute} />
      <TimePicker key={`end-${key}`} label="Until" name="end" defaultMinute={endMinute} />

      {state.status === "error" ? (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="sm:self-start">
        {pending ? "Adding…" : "Add these hours"}
      </Button>
    </form>
  );
}
