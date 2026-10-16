import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bookAgainOpen,
  milestoneReached,
  packageOption,
  packagePriceRange,
  packageSummary,
  splitMinor,
} from "./pricing";

test("takes 10% of a session below the $100 milestone", () => {
  assert.deepEqual(splitMinor(3_500, { feeToDateMinor: 0 }), { tutorMinor: 3_150, platformMinor: 350 });
});

test("the crossing session takes 10% up to the $100 line and 5% on the rest", () => {
  assert.deepEqual(splitMinor(3_500, { feeToDateMinor: 9_800 }), { tutorMinor: 3_225, platformMinor: 275 });
});

test("a session whose full fee lands exactly on $100 takes the full 10%", () => {
  assert.deepEqual(splitMinor(5_000, { feeToDateMinor: 9_500 }), { tutorMinor: 4_500, platformMinor: 500 });
});

test("takes 5% from the milestone on, and never nothing", () => {
  assert.deepEqual(splitMinor(3_500, { feeToDateMinor: 10_000 }), { tutorMinor: 3_325, platformMinor: 175 });
  assert.deepEqual(splitMinor(3_500, { feeToDateMinor: 50_000 }), { tutorMinor: 3_325, platformMinor: 175 });
});

test("a through-final session pays $3.15, then $1.57 past the milestone", () => {
  const option = packageOption("through_final", 3_500);
  assert.equal(option.perSessionMinor, 3_150);
  assert.deepEqual(splitMinor(option.perSessionMinor, { feeToDateMinor: 0 }), { tutorMinor: 2_835, platformMinor: 315 });
  assert.deepEqual(splitMinor(option.perSessionMinor, { feeToDateMinor: 10_000 }), { tutorMinor: 2_993, platformMinor: 157 });
});

test("the milestone is reached at exactly $100 in fees", () => {
  assert.equal(milestoneReached(9_999), false);
  assert.equal(milestoneReached(10_000), true);
});

function lifetime(sessions: number, sessionMinor = 3_500) {
  let feeToDateMinor = 0;
  let tutorMinor = 0;
  const fees: number[] = [];
  for (let i = 0; i < sessions; i += 1) {
    const split = splitMinor(sessionMinor, { feeToDateMinor });
    feeToDateMinor += split.platformMinor;
    tutorMinor += split.tutorMinor;
    fees.push(split.platformMinor);
  }
  return { fees, tutorMinor, platformMinor: feeToDateMinor };
}

test("at $35 the 29th session crosses $100 and every later one takes $1.75", () => {
  const { fees } = lifetime(32);
  assert.deepEqual(fees, [...Array(28).fill(350), 275, 175, 175, 175]);
});

test("32 sessions at $35 pay the tutor $1,014.00 and the platform $106.00", () => {
  const { tutorMinor, platformMinor } = lifetime(32);
  assert.equal(tutorMinor, 101_400);
  assert.equal(platformMinor, 10_600);
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

test("package prices scale from the tutor's rate", () => {
  const priced = [2_500, 3_500, 5_000].map((rate) => ({
    rate,
    exam: packageOption("exam_anchored", rate).priceMinor,
    final: packageOption("through_final", rate).priceMinor,
    topUp: packageOption("top_up", rate).priceMinor,
  }));
  assert.deepEqual(priced, [
    { rate: 2_500, exam: 10_000, final: 18_000, topUp: 2_500 },
    { rate: 3_500, exam: 14_000, final: 25_200, topUp: 3_500 },
    { rate: 5_000, exam: 20_000, final: 36_000, topUp: 5_000 },
  ]);
});

test("through the final shows its saving against eight single sessions", () => {
  assert.deepEqual(packageOption("through_final", 2_500), {
    kind: "through_final",
    sessions: 8,
    priceMinor: 18_000,
    perSessionMinor: 2_250,
    savingsMinor: 2_000,
  });
});

test("a package price spans the cheapest to the dearest tutor", () => {
  assert.deepEqual(packagePriceRange("exam_anchored", [3_500, 2_500, 5_000]), {
    lowMinor: 10_000,
    highMinor: 20_000,
  });
  assert.deepEqual(packagePriceRange("through_final", [2_500, 5_000]), {
    lowMinor: 18_000,
    highMinor: 36_000,
  });
});

test("tutors at one rate give one package price", () => {
  assert.deepEqual(packagePriceRange("through_final", [3_500, 3_500]), {
    lowMinor: 25_200,
    highMinor: 25_200,
  });
});
