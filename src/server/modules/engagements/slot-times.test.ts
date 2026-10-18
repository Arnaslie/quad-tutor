import assert from "node:assert/strict";
import { test } from "node:test";

import { expandSlots } from "./slot-times";

const TUESDAY = 2;
const SUNDAY = 0;
const timeZone = "America/Chicago";

function iso(slots: Date[]): string[] {
  return slots.map((slot) => slot.toISOString());
}

test("a window opens at the tutor's campus time, whatever the server's time zone", () => {
  const slots = expandSlots({
    windows: [{ weekday: TUESDAY, startMinute: 22 * 60, endMinute: 24 * 60 }],
    timeZone,
    now: new Date("2026-10-18T12:00:00Z"),
    taken: new Set(),
  });

  assert.deepEqual(iso(slots), [
    "2026-10-21T03:00:00.000Z",
    "2026-10-21T04:00:00.000Z",
    "2026-10-28T03:00:00.000Z",
    "2026-10-28T04:00:00.000Z",
  ]);
});

test("the hour the clocks skip in spring is not offered, and no slot is offered twice", () => {
  const slots = expandSlots({
    windows: [{ weekday: SUNDAY, startMinute: 1 * 60, endMinute: 4 * 60 }],
    timeZone,
    now: new Date("2027-03-07T12:00:00Z"),
    taken: new Set(),
  });

  assert.deepEqual(iso(slots), ["2027-03-14T07:00:00.000Z", "2027-03-14T08:00:00.000Z"]);
});

test("the hour the clocks repeat in fall is offered once, at its first occurrence", () => {
  const slots = expandSlots({
    windows: [{ weekday: SUNDAY, startMinute: 1 * 60, endMinute: 3 * 60 }],
    timeZone,
    now: new Date("2026-10-25T12:00:00Z"),
    taken: new Set(),
  });

  assert.deepEqual(iso(slots), ["2026-11-01T06:00:00.000Z", "2026-11-01T08:00:00.000Z"]);
});

test("a taken slot and a slot inside the 12-hour lead are not offered", () => {
  const slots = expandSlots({
    windows: [{ weekday: TUESDAY, startMinute: 22 * 60, endMinute: 24 * 60 }],
    timeZone,
    now: new Date("2026-10-20T16:00:00Z"),
    taken: new Set([Date.parse("2026-10-28T03:00:00Z")]),
  });

  assert.deepEqual(iso(slots), ["2026-10-21T04:00:00.000Z", "2026-10-28T04:00:00.000Z"]);
});

test("a campus far east of UTC still gets the first occurrence of a repeated hour", () => {
  const slots = expandSlots({
    windows: [{ weekday: SUNDAY, startMinute: 2 * 60, endMinute: 3 * 60 }],
    timeZone: "Pacific/Auckland",
    now: new Date("2026-03-30T00:00:00Z"),
    taken: new Set(),
  });

  assert.deepEqual(iso(slots), ["2026-04-04T13:00:00.000Z", "2026-04-11T14:00:00.000Z"]);
});
