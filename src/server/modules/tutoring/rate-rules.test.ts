import assert from "node:assert/strict";
import { test } from "node:test";

import { setCourseRateInput } from "./input";
import { rateMinorFromDollars } from "./rate-rules";

test("a rate is whole dollars from $25 to $50", () => {
  assert.deepEqual(
    [24, 25, 35, 50, 51, 35.5, 0, -30, Number.NaN].map(rateMinorFromDollars),
    [null, 2_500, 3_500, 5_000, null, null, null, null, null],
  );
});

const tutorCourseId = "3f0c7a52-6c1e-4f43-9d2a-5a1b8e0c9d11";

test("the rate form's dollars parse to minor units", () => {
  const parsed = setCourseRateInput.safeParse({ tutorCourseId, dollars: "40" });
  assert.deepEqual(parsed.success ? parsed.data : parsed.error.issues, { tutorCourseId, rateMinor: 4_000 });
});

test("the rate form refuses cents, blanks and out-of-range dollars", () => {
  const accepted = ["35.50", "", "abc", "24", "51", null].map(
    (dollars) => setCourseRateInput.safeParse({ tutorCourseId, dollars }).success,
  );
  assert.deepEqual(accepted, [false, false, false, false, false, false]);
});
