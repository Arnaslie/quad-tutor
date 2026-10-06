import assert from "node:assert/strict";
import { test } from "node:test";

import { packageOption, splitMinor } from "./pricing";

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
