import assert from "node:assert/strict";
import { test } from "node:test";

import { bookAgainOpen, packageOption, packageSummary, splitMinor } from "./pricing";

test("takes 10% of a session under the cap", () => {
  assert.deepEqual(splitMinor(3_500, 0), { tutorMinor: 3_150, platformMinor: 350 });
});

test("the crossing session takes only what is left under the cap", () => {
  assert.deepEqual(splitMinor(3_500, 9_800), { tutorMinor: 3_300, platformMinor: 200 });
});

test("takes nothing once the cap is reached", () => {
  assert.deepEqual(splitMinor(3_500, 10_000), { tutorMinor: 3_500, platformMinor: 0 });
});

test("takes nothing when the meter is above the cap", () => {
  assert.deepEqual(splitMinor(3_500, 10_350), { tutorMinor: 3_500, platformMinor: 0 });
});

test("a through-final session pays $3.15", () => {
  const option = packageOption("through_final");
  assert.equal(option.perSessionMinor, 3_150);
  assert.deepEqual(splitMinor(option.perSessionMinor, 0), {
    tutorMinor: 2_835,
    platformMinor: 315,
  });
});

const day = 86_400_000;
const now = new Date("2026-10-08T15:00:00Z");

test("book again stays shut while sessions are left to book", () => {
  assert.equal(bookAgainOpen({ sessionsRemaining: 1, termEndsOn: new Date(now.getTime() + 60 * day), now }), false);
});

test("book again is shut once the term has ended", () => {
  assert.equal(bookAgainOpen({ sessionsRemaining: 0, termEndsOn: new Date(now.getTime() - day), now }), false);
});

test("book again opens mid-term, not only near the end", () => {
  assert.equal(bookAgainOpen({ sessionsRemaining: 0, termEndsOn: new Date(now.getTime() + 60 * day), now }), true);
});

test("a package summary names the sessions the tutor commits to", () => {
  assert.equal(packageSummary("through_final"), "8 sessions, through the final");
  assert.equal(packageSummary("exam_anchored"), "4 sessions, up to the next exam");
});
