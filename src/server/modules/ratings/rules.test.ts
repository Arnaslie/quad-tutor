import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_RATINGS, MIN_SESSIONS, publicRating } from "./rules";

test("nothing is public below 10 sessions, however many ratings", () => {
  assert.equal(publicRating(45, 9, MIN_SESSIONS - 1), null);
  assert.equal(publicRating(25, MIN_RATINGS, 9), null);
});

test("nothing is public below 5 ratings, however many sessions", () => {
  assert.equal(publicRating(20, MIN_RATINGS - 1, 40), null);
  assert.equal(publicRating(0, 0, 40), null);
});

test("10 sessions and 5 ratings is public", () => {
  assert.deepEqual(publicRating(23, 5, 10), { average: "4.6", count: 5 });
});

test("the average rounds half up to one decimal", () => {
  assert.deepEqual(publicRating(57, 12, 30), { average: "4.8", count: 12 });
  assert.deepEqual(publicRating(50, 10, 10), { average: "5.0", count: 10 });
  assert.deepEqual(publicRating(5, 5, 10), { average: "1.0", count: 5 });
});
