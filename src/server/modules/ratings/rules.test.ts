import assert from "node:assert/strict";
import { test } from "node:test";

import { publicRating } from "./rules";

test("nothing is public below $100 in fees, however many ratings", () => {
  assert.equal(publicRating(45, 9, 9_999), null);
  assert.equal(publicRating(25, 5, 0), null);
});

test("nothing is public below 5 ratings, however much the tutor has paid", () => {
  assert.equal(publicRating(20, 4, 40_000), null);
  assert.equal(publicRating(0, 0, 40_000), null);
});

test("$100 in fees and 5 ratings is public", () => {
  assert.deepEqual(publicRating(23, 5, 10_000), { average: "4.6", count: 5 });
});

test("the average rounds half up to one decimal", () => {
  assert.deepEqual(publicRating(57, 12, 30_000), { average: "4.8", count: 12 });
  assert.deepEqual(publicRating(50, 10, 10_000), { average: "5.0", count: 10 });
  assert.deepEqual(publicRating(5, 5, 10_000), { average: "1.0", count: 5 });
});
