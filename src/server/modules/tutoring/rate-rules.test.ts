import assert from "node:assert/strict";
import { test } from "node:test";

import { setCourseRateInput } from "./input";
import { packageOption } from "@/server/modules/billing/pricing";

import { MAX_RATE_DOLLARS, rateMinorFromDollars } from "./rate-rules";

test("a rate is any whole number of dollars from $1 up to what Stripe can charge", () => {
  assert.deepEqual(
    [1, 24, 51, 300, 124_999, 125_000, 35.5, 0, -30, Number.NaN].map(rateMinorFromDollars),
    [100, 2_400, 5_100, 30_000, 12_499_900, null, null, null, null, null],
  );
});

const tutorCourseId = "3f0c7a52-6c1e-4f43-9d2a-5a1b8e0c9d11";

test("the rate form's dollars parse to minor units", () => {
  const parsed = setCourseRateInput.safeParse({ tutorCourseId, dollars: "40" });
  assert.deepEqual(parsed.success ? parsed.data : parsed.error.issues, { tutorCourseId, rateMinor: 4_000 });
});

test("the rate form refuses cents, blanks and dollars below $1", () => {
  const accepted = ["35.50", "", "abc", "0", "-5", null].map(
    (dollars) => setCourseRateInput.safeParse({ tutorCourseId, dollars }).success,
  );
  assert.deepEqual(accepted, [false, false, false, false, false, false]);
});

test("the largest package at the highest rate is one Stripe can charge", () => {
  const largest = Math.max(
    ...(["exam_anchored", "through_final", "top_up"] as const).map(
      (kind) => packageOption(kind, MAX_RATE_DOLLARS * 100).priceMinor,
    ),
  );
  assert.ok(largest <= 99_999_999, `${largest}`);
});
