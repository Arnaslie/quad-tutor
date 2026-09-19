/**
 * The only file in this module that touches the database.
 *
 * Everything impure lives here — queries, the clock, tenant scoping — so that
 * `score.ts` stays a pure function of its inputs. See the extraction seam note
 * in CLAUDE.md.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { course, courseOffering, term, tutorCourse } from "@/server/db/schema";

import { rankCandidates, type Candidate, type ScoredCandidate } from "./score";

/** How many tutors a student may have pending requests with at once. */
export const MAX_PARALLEL_ASKS = 3;

/** Requests expire at 12h — a student with an exam on Thursday cannot wait a day. */
export const REQUEST_EXPIRY_HOURS = 12;

/**
 * Presentation is a function of supply count, so the caller needs the count,
 * not just the list. 0 → demand capture, 1–2 → single reveal, 3+ → deck.
 * See docs/decisions.md.
 */
export type Deck = {
  candidates: ScoredCandidate[];
  presentation: "demand_capture" | "single_reveal" | "deck";
};

export function presentationFor(count: number): Deck["presentation"] {
  if (count === 0) return "demand_capture";
  if (count <= 2) return "single_reveal";
  return "deck";
}

/**
 * Every tutor available for a given offering, ranked.
 *
 * Scoped by `institutionId` — a query that forgets the tenant key leaks across
 * campuses silently.
 */
export async function buildDeck(params: {
  courseOfferingId: string;
  institutionId: string;
}): Promise<Deck> {
  const offering = await db
    .select({
      courseId: courseOffering.courseId,
      professorId: courseOffering.professorId,
      termStartsOn: term.startsOn,
    })
    .from(courseOffering)
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(courseOffering.id, params.courseOfferingId),
        eq(course.institutionId, params.institutionId),
      ),
    )
    .limit(1);

  const target = offering.at(0);
  if (!target) return { candidates: [], presentation: "demand_capture" };

  const rows = await db
    .select({
      tutorCourseId: tutorCourse.id,
      gradeEarned: tutorCourse.gradeEarned,
      takenUnderProfessorId: tutorCourse.takenUnderProfessorId,
      takenTermStartsOn: term.startsOn,
      scoreSampleCount: tutorCourse.scoreSampleCount,
      scorePosteriorMeanBp: tutorCourse.scorePosteriorMean,
    })
    .from(tutorCourse)
    .innerJoin(term, eq(term.id, tutorCourse.takenTermId))
    .where(
      and(
        eq(tutorCourse.courseId, target.courseId),
        eq(tutorCourse.status, "active"),
      ),
    );

  const candidates: Candidate[] = rows.map((row) => ({
    tutorCourseId: row.tutorCourseId,
    gradeEarned: row.gradeEarned,
    termsSinceTaken: termsBetween(row.takenTermStartsOn, target.termStartsOn),
    matchesProfessor:
      target.professorId !== null &&
      row.takenUnderProfessorId === target.professorId,
    scoreSampleCount: row.scoreSampleCount,
    scorePosteriorMeanBp: row.scorePosteriorMeanBp,
  }));

  const ranked = rankCandidates(candidates);
  return { candidates: ranked, presentation: presentationFor(ranked.length) };
}

/** Approximate: two terms per academic year. Good enough for recency decay. */
function termsBetween(takenStartsOn: string, offeringStartsOn: string): number {
  const months =
    (new Date(offeringStartsOn).getTime() - new Date(takenStartsOn).getTime()) /
    (1000 * 60 * 60 * 24 * 30.44);
  return Math.max(0, Math.round(months / 6));
}
