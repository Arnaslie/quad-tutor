import assert from "node:assert/strict";
import { test } from "node:test";

import { cancelClosesPackage, cancelSplit, hoursBefore, keptShareBp } from "./cancel-rules";

test("a student cancelling 24 hours or more ahead keeps nothing back from the session", () => {
  assert.equal(keptShareBp(72, "student"), 0);
  assert.equal(keptShareBp(24, "student"), 0);
});

test("a student cancelling inside 24 hours pays half, and inside 12 hours three quarters", () => {
  assert.equal(keptShareBp(23.99, "student"), 5_000);
  assert.equal(keptShareBp(12, "student"), 5_000);
  assert.equal(keptShareBp(11.99, "student"), 7_500);
  assert.equal(keptShareBp(0.01, "student"), 7_500);
});

test("a tutor cancelling costs the student nothing at any time", () => {
  assert.equal(keptShareBp(30, "tutor"), 0);
  assert.equal(keptShareBp(13, "tutor"), 0);
  assert.equal(keptShareBp(0.5, "tutor"), 0);
});

test("a $35 session splits $17.50 / $17.50 inside 24 hours and $26.25 / $8.75 inside 12", () => {
  assert.deepEqual(cancelSplit(3_500, 20, "student"), { keptMinor: 1_750, returnedMinor: 1_750 });
  assert.deepEqual(cancelSplit(3_500, 3, "student"), { keptMinor: 2_625, returnedMinor: 875 });
  assert.deepEqual(cancelSplit(3_500, 30, "student"), { keptMinor: 0, returnedMinor: 3_500 });
  assert.deepEqual(cancelSplit(3_500, 3, "tutor"), { keptMinor: 0, returnedMinor: 3_500 });
});

test("the kept share rounds down, so the odd cent goes back to the student", () => {
  assert.deepEqual(cancelSplit(3_150, 3, "student"), { keptMinor: 2_362, returnedMinor: 788 });
  assert.deepEqual(cancelSplit(101, 20, "student"), { keptMinor: 50, returnedMinor: 51 });
});

test("hours before counts fractions of an hour", () => {
  const at = new Date("2026-10-20T15:00:00Z");
  assert.equal(hoursBefore(at, new Date("2026-10-19T15:00:00Z")), 24);
  assert.equal(hoursBefore(at, new Date("2026-10-20T14:30:00Z")), 0.5);
});

test("only a student cancel of a one-time session closes the package and refunds the card", () => {
  assert.equal(cancelClosesPackage(1, "student"), true);
  assert.equal(cancelClosesPackage(1, "tutor"), false);
  assert.equal(cancelClosesPackage(4, "student"), false);
  assert.equal(cancelClosesPackage(8, "student"), false);
});
