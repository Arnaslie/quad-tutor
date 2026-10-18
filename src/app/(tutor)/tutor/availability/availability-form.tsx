"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Select } from "@/components/field";

import { addAvailabilityAction, type AvailabilityState } from "./actions";
import { WEEKDAYS } from "./time";
import { TimePicker } from "./time-picker";

const INITIAL: AvailabilityState = { status: "idle" };

const DEFAULT_START = 18 * 60;
const DEFAULT_END = 21 * 60;

export function AvailabilityForm() {
  const [state, submit, pending] = useActionState(addAvailabilityAction, INITIAL);
  const dayId = useId();

  return (
    <form action={submit} className="flex flex-col gap-4">
      <Field id={dayId} label="Day">
        <Select id={dayId} name="weekday" defaultValue="1">
          {WEEKDAYS.map((day, index) => (
            <option key={day} value={index}>
              {day}
            </option>
          ))}
        </Select>
      </Field>

      <TimePicker label="From" name="start" defaultMinute={DEFAULT_START} />
      <TimePicker label="Until" name="end" defaultMinute={DEFAULT_END} />

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
