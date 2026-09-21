export type RankingWeights = {
  professorMatch: number;
  gradeA: number;
  gradeAMinus: number;

  recencyDecayPerTerm: number;

  posteriorWeight: number;

  silentExpiryPenalty: number;
};

export const DEFAULT_WEIGHTS: RankingWeights = {
  professorMatch: 40,
  gradeA: 20,
  gradeAMinus: 12,
  recencyDecayPerTerm: 5,
  posteriorWeight: 30,
  silentExpiryPenalty: 15,
};

export type Candidate = {
  tutorCourseId: string;
  gradeEarned: string;

  termsSinceTaken: number;
  matchesProfessor: boolean;
  scoreSampleCount: number;

  scorePosteriorMeanBp: number | null;

  recentSilentExpiries: number;
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
  score -= candidate.recentSilentExpiries * weights.silentExpiryPenalty;

  if (candidate.scoreSampleCount > 0 && candidate.scorePosteriorMeanBp !== null) {
    score += (candidate.scorePosteriorMeanBp / 10_000) * weights.posteriorWeight;
  }

  return score;
}

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
