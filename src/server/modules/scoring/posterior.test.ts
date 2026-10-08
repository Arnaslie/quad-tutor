import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_POOL,
  PRIOR_MIN_SAMPLES,
  RENEWAL_PRIOR_BP,
  STAR_PRIOR_BP,
  addPools,
  posteriorBp,
  priorBp,
  renewalPool,
  starPool,
  starsToBp,
} from "./posterior";

test("stars map 1..5 onto 0..10 000 bp, so the fallback prior is 4.0 stars", () => {
  assert.equal(starsToBp(1), 0);
  assert.equal(starsToBp(5), 10_000);
  assert.equal(STAR_PRIOR_BP, 7_500);
  assert.deepEqual(starPool(3, 12), { samples: 3, totalBp: 22_500 });
});

test("with no samples the posterior is the prior", () => {
  assert.equal(posteriorBp(EMPTY_POOL, STAR_PRIOR_BP), STAR_PRIOR_BP);
  assert.equal(posteriorBp(EMPTY_POOL, RENEWAL_PRIOR_BP), 4_000);
});

test("stars smooth as (m·C + Σ) / (m + n) with m = 5", () => {
  assert.equal(posteriorBp(starPool(5, 25), STAR_PRIOR_BP), 8_750);
  assert.equal(posteriorBp(starPool(1, 1), STAR_PRIOR_BP), 6_250);
});

test("renewals smooth as (successes + 5·C) / (trials + 5)", () => {
  assert.equal(posteriorBp(renewalPool(5, 5), RENEWAL_PRIOR_BP), 7_000);
  assert.equal(posteriorBp(renewalPool(5, 0), RENEWAL_PRIOR_BP), 2_000);
  assert.equal(posteriorBp(renewalPool(1, 0), 6_000), 5_000);
});

test("a large sample overwhelms the prior", () => {
  assert.equal(posteriorBp(starPool(10_000, 50_000), 0), 9_995);
});

test("the prior falls back course, then campus at 20 samples, then the constant", () => {
  const course = renewalPool(PRIOR_MIN_SAMPLES, 10);
  const campus = renewalPool(PRIOR_MIN_SAMPLES, 5);
  const thin = renewalPool(PRIOR_MIN_SAMPLES - 1, 19);

  assert.equal(priorBp(course, campus, RENEWAL_PRIOR_BP), 5_000);
  assert.equal(priorBp(thin, campus, RENEWAL_PRIOR_BP), 2_500);
  assert.equal(priorBp(thin, thin, RENEWAL_PRIOR_BP), RENEWAL_PRIOR_BP);
  assert.equal(priorBp(EMPTY_POOL, EMPTY_POOL, STAR_PRIOR_BP), STAR_PRIOR_BP);
});

test("a course of all 1-star ratings is a real prior of 0, not a missing one", () => {
  assert.equal(priorBp(starPool(PRIOR_MIN_SAMPLES, PRIOR_MIN_SAMPLES), EMPTY_POOL, STAR_PRIOR_BP), 0);
});

test("pools add", () => {
  assert.deepEqual(addPools(renewalPool(2, 1), renewalPool(3, 3)), renewalPool(5, 4));
});
