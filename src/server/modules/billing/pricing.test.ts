import assert from "node:assert/strict";
import { test } from "node:test";

import { bookAgainOpen, packageOption, packageSummary, splitMinor, takeRateBp } from "./pricing";

test("takes 10% of a session under the cap", () => {
  assert.deepEqual(splitMinor(3_500, { rateBp: 1_000, chargedThisTermMinor: 0 }), { tutorMinor: 3_150, platformMinor: 350 });
});

test("the crossing session takes only what is left under the cap", () => {
  assert.deepEqual(splitMinor(3_500, { rateBp: 1_000, chargedThisTermMinor: 9_800 }), { tutorMinor: 3_300, platformMinor: 200 });
});

test("takes nothing once the cap is reached", () => {
  assert.deepEqual(splitMinor(3_500, { rateBp: 1_000, chargedThisTermMinor: 10_000 }), { tutorMinor: 3_500, platformMinor: 0 });
});

test("takes nothing when the meter is above the cap", () => {
  assert.deepEqual(splitMinor(3_500, { rateBp: 1_000, chargedThisTermMinor: 10_350 }), { tutorMinor: 3_500, platformMinor: 0 });
});

test("a through-final session pays $3.15", () => {
  const option = packageOption("through_final");
  assert.equal(option.perSessionMinor, 3_150);
  assert.deepEqual(splitMinor(option.perSessionMinor, { rateBp: 1_000, chargedThisTermMinor: 0 }), {
    tutorMinor: 2_835,
    platformMinor: 315,
  });
});

function firstTerm(sessions: number, sessionMinor = 3_500) {
  let chargedThisTermMinor = 0;
  let tutorMinor = 0;
  const fees: number[] = [];
  for (let earnedBefore = 0; earnedBefore < sessions; earnedBefore += 1) {
    const split = splitMinor(sessionMinor, { rateBp: takeRateBp(earnedBefore), chargedThisTermMinor });
    chargedThisTermMinor += split.platformMinor;
    tutorMinor += split.tutorMinor;
    fees.push(split.platformMinor);
  }
  return { fees, tutorMinor, platformMinor: chargedThisTermMinor };
}

test("the 10th session at $35 takes $3.50 and the 11th takes $1.75", () => {
  const { fees } = firstTerm(11);
  assert.equal(fees[9], 350);
  assert.equal(fees[10], 175);
});

test("the 48th session at $35 in a first term pays $0.25 and lands the meter on $100", () => {
  const { fees, platformMinor } = firstTerm(49);
  assert.equal(fees[46], 175);
  assert.equal(fees[47], 25);
  assert.equal(fees[48], 0);
  assert.equal(platformMinor, 10_000);
});

test("32 sessions at $35 pay the tutor $1,046.50 and the platform $73.50", () => {
  const { tutorMinor, platformMinor } = firstTerm(32);
  assert.equal(tutorMinor, 104_650);
  assert.equal(platformMinor, 7_350);
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
