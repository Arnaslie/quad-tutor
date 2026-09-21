"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/button";
import { Field, Select } from "@/components/field";

import { addAvailabilityAction, type AvailabilityState } from "./actions";
import { TIME_OPTIONS, WEEKDAYS, formatMinuteOfDay } from "./time";

const INITIAL: AvailabilityState = { status: "idle" };

const DEFAULT_START = 18 * 60;
const DEFAULT_END = 21 * 60;

export function AvailabilityForm() {
  const [state, submit, pending] = useActionState(addAvailabilityAction, INITIAL);
  const dayId = useId();
  const startId = useId();
  const endId = useId();

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

      <div className="grid grid-cols-2 gap-3">
        <Field id={startId} label="From">
          <Select id={startId} name="startMinute" defaultValue={DEFAULT_START}>
            {TIME_OPTIONS.map((minute) => (
              <option key={minute} value={minute}>
                {formatMinuteOfDay(minute)}
              </option>
            ))}
          </Select>
        </Field>

        <Field id={endId} label="Until">
          <Select id={endId} name="endMinute" defaultValue={DEFAULT_END}>
            {TIME_OPTIONS.map((minute) => (
              <option key={minute} value={minute}>
                {formatMinuteOfDay(minute)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

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
