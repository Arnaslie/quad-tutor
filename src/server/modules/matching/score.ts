/**
 * Pure ranking. No I/O, no ORM, no clock, no randomness.
 *
 * This file is the extraction seam: if matching ever moves to its own service,
 * this is what moves. Keeping it pure is what makes that cheap — and what makes
 * ranking testable without a database. Anything needing the current time or a
 * query belongs in `candidates.ts`.
 *
 * Launch reality: n=0 for every tutor, so this is a deterministic sort on
 * observable facts. The Bayesian posterior is only consulted once a tutor has
 * delivered sessions; the shrinkage + bandit ranker lands in V1. See
 * docs/decisions.md.
 */

export type RankingWeights = {
  professorMatch: number;
  gradeA: number;
  gradeAMinus: number;
  /** Penalty per term since the tutor took the course. */
  recencyDecayPerTerm: number;
  /** How far the posterior can move a tutor once n > 0. */
  posteriorWeight: number;
};

/** Seed values. These belong in a database row so they can be tuned without a deploy. */
export const DEFAULT_WEIGHTS: RankingWeights = {
  professorMatch: 40,
  gradeA: 20,
  gradeAMinus: 12,
  recencyDecayPerTerm: 5,
  posteriorWeight: 30,
};

export type Candidate = {
  tutorCourseId: string;
  gradeEarned: string;
  /** Computed by the caller so this module stays clock-free. */
  termsSinceTaken: number;
  matchesProfessor: boolean;
  scoreSampleCount: number;
  /** Basis points (0–10000), or null while n = 0. */
  scorePosteriorMeanBp: number | null;
};

export type ScoredCandidate = Candidate & { score: number };

function gradePoints(grade: string, weights: RankingWeights): number {
  const normalised = grade.trim().toUpperCase();
  if (normalised === "A" || normalised === "A+") return weights.gradeA;
  if (normalised === "A-" || normalised === "A−") return weights.gradeAMinus;
  return 0;
}

export function scoreCandidate(
  candidate: Candidate,
  weights: RankingWeights = DEFAULT_WEIGHTS,
): number {
  let score = 0;

  if (candidate.matchesProfessor) score += weights.professorMatch;
  score += gradePoints(candidate.gradeEarned, weights);
  score -= candidate.termsSinceTaken * weights.recencyDecayPerTerm;

  // Only consulted once the tutor has a delivered-session history.
  if (candidate.scoreSampleCount > 0 && candidate.scorePosteriorMeanBp !== null) {
    score += (candidate.scorePosteriorMeanBp / 10_000) * weights.posteriorWeight;
  }

  return score;
}

/**
 * Deterministic: ties break on `tutorCourseId` so the same input always yields
 * the same deck. Exploration (giving new tutors a shot above their score) is a
 * V1 concern and belongs here, behind an explicit seed — never `Math.random()`.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  weights: RankingWeights = DEFAULT_WEIGHTS,
): ScoredCandidate[] {
  return candidates
    .map((candidate) => ({ ...candidate, score: scoreCandidate(candidate, weights) }))
    .sort((a, b) =>
      b.score !== a.score
        ? b.score - a.score
        : a.tutorCourseId.localeCompare(b.tutorCourseId),
    );
}
