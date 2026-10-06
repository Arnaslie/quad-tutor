import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_POOL,
  RENEWAL_PRIOR_BP,
  posteriorBp,
  priorBp,
  renewalPool,
  starPool,
} from "@/server/modules/scoring/posterior";

import { DEFAULT_WEIGHTS, rankCandidates, scoreCandidate, type Candidate } from "./score";

const base: Candidate = {
  tutorCourseId: "x",
  gradeEarned: "A",
  termsSinceTaken: 1,
  matchesProfessor: false,
  scorePosteriorMeanBp: null,
  renewalPosteriorMeanBp: null,
  recentSilentExpiries: 0,
};

test("stars and renewals carry 15 each, beside a professor match of 40", () => {
  assert.equal(DEFAULT_WEIGHTS.ratingWeight, 15);
  assert.equal(DEFAULT_WEIGHTS.renewalWeight, 15);
  assert.equal(DEFAULT_WEIGHTS.professorMatch, 40);
  const full = scoreCandidate({ ...base, scorePosteriorMeanBp: 10_000, renewalPosteriorMeanBp: 10_000 });
  assert.equal(full - scoreCandidate(base), 30);
});

test("an unrated tutor scored at the prior is not below a rated average tutor", () => {
  const course = starPool(40, 40 * 4.5);
  const prior = priorBp(course, EMPTY_POOL, 0);
  const renewalPrior = priorBp(renewalPool(40, 20), EMPTY_POOL, RENEWAL_PRIOR_BP);

  const unrated = {
    ...base,
    tutorCourseId: "a-unrated",
    scorePosteriorMeanBp: posteriorBp(EMPTY_POOL, prior),
    renewalPosteriorMeanBp: posteriorBp(EMPTY_POOL, renewalPrior),
  };
  const average = {
    ...base,
    tutorCourseId: "b-rated",
    scorePosteriorMeanBp: posteriorBp(starPool(12, 12 * 4.5), prior),
    renewalPosteriorMeanBp: posteriorBp(renewalPool(6, 3), renewalPrior),
  };

  assert.ok(scoreCandidate(unrated) >= scoreCandidate(average));
  assert.equal(rankCandidates([average, unrated])[0].tutorCourseId, "a-unrated");
});

test("a claim the stats job hasn't reached yet adds nothing for either term", () => {
  assert.equal(scoreCandidate(base), 20 - 5);
  assert.equal(scoreCandidate({ ...base, scorePosteriorMeanBp: 7_500 }), 15 + 11.25);
  assert.equal(scoreCandidate({ ...base, renewalPosteriorMeanBp: 4_000 }), 15 + 6);
});
