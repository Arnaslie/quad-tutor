import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMinuteOfDay } from "@/app/(tutor)/tutor/availability/time";

import { toClockTime } from "./clock-rules";
import { addAvailabilityInput } from "./input";

function hours(start: [string, string, string], end: [string, string, string]) {
  const clock = ([hour, minute, period]: [string, string, string]) => ({ hour, minute, period });
  const parsed = addAvailabilityInput.safeParse({ weekday: 2, start: clock(start), end: clock(end) });
  if (!parsed.success) return "rejected";
  return `${formatMinuteOfDay(parsed.data.startMinute)} – ${formatMinuteOfDay(parsed.data.endMinute)}`;
}

test("the hour, minute and AM/PM a tutor picks become the window they see", () => {
  assert.deepEqual(
    [
      hours(["12", "30", "PM"], ["2", "45", "PM"]),
      hours(["7", "20", "PM"], ["9", "20", "PM"]),
      hours(["12", "0", "AM"], ["1", "0", "AM"]),
      hours(["10", "45", "PM"], ["12", "0", "AM"]),
    ],
    ["12:30 PM – 2:45 PM", "7:20 PM – 9:20 PM", "12:00 AM – 1:00 AM", "10:45 PM – Midnight"],
  );
});

test("the form refuses an hour, minute or AM/PM that is not on the clock", () => {
  assert.deepEqual(
    [
      hours(["13", "0", "PM"], ["2", "0", "PM"]),
      hours(["1", "60", "PM"], ["2", "0", "PM"]),
      hours(["1", "0", "XM"], ["2", "0", "PM"]),
      hours(["", "", ""], ["2", "0", "PM"]),
    ],
    ["rejected", "rejected", "rejected", "rejected"],
  );
});

test("a stored minute shows back as the same hour, minute and AM/PM", () => {
  assert.deepEqual([1160, 0, 1440, 720].map(toClockTime), [
    { hour: 7, minute: 20, period: "PM" },
    { hour: 12, minute: 0, period: "AM" },
    { hour: 12, minute: 0, period: "AM" },
    { hour: 12, minute: 0, period: "PM" },
  ]);
});
