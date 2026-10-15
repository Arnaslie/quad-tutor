import assert from "node:assert/strict";
import { test } from "node:test";

import { setCourseRateInput } from "./input";
import { rateMinorFromDollars } from "./rate-rules";

test("a rate is whole dollars from $1 to $200", () => {
  assert.deepEqual(
    [1, 24, 51, 200, 201, 100_000, 35.5, 0, -30, Number.NaN].map(rateMinorFromDollars),
    [100, 2_400, 5_100, 20_000, null, null, null, null, null, null],
  );
});

const tutorCourseId = "3f0c7a52-6c1e-4f43-9d2a-5a1b8e0c9d11";

test("the rate form's dollars parse to minor units", () => {
  const parsed = setCourseRateInput.safeParse({ tutorCourseId, dollars: "40" });
  assert.deepEqual(parsed.success ? parsed.data : parsed.error.issues, { tutorCourseId, rateMinor: 4_000 });
});

test("the rate form refuses cents, blanks and dollars outside $1 to $200", () => {
  const accepted = ["35.50", "", "abc", "0", "-5", "201", null].map(
    (dollars) => setCourseRateInput.safeParse({ tutorCourseId, dollars }).success,
  );
  assert.deepEqual(accepted, [false, false, false, false, false, false, false]);
});
