/**
 * The only file in this module that touches the database.
 *
 * Everything impure lives here — queries, the clock, tenant scoping — so that
 * `score.ts` stays a pure function of its inputs. See the extraction seam note
 * in CLAUDE.md.
 */

import { and, eq, ne, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseOffering,
  matchRequest,
  professor,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";

import { rankCandidates, type Candidate, type ScoredCandidate } from "./score";

/** Requests expire at 12h — a student with an exam on Thursday cannot wait a day. */
export const REQUEST_EXPIRY_HOURS = 12;

/**
 * Presentation is a function of supply count, so the caller needs the count,
 * not just the list. 0 → demand capture, 1–2 → single reveal, 3+ → deck.
 * See docs/decisions.md.
 */
/**
 * What a card shows. Deliberately absent: any quality score, star rating or
 * badge. The score is hidden and ranking is the only place it is expressed —
 * see the rejected-alternatives section of docs/decisions.md.
 */
export type DeckCard = ScoredCandidate & {
  tutorProfileId: string;
  tutorName: string;
  headline: string | null;
  bio: string | null;
  /** The professor the tutor took it under — the wedge, stated plainly. */
  takenUnderProfessorName: string | null;
  takenTermName: string;
};

export type Deck = {
  candidates: DeckCard[];
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
  /**
   * The student looking at the deck. Their own tutor profile is filtered out.
   *
   * Required, not optional: on a peer campus the same person being on both
   * sides is routine, and a forgotten argument here is not a missing filter,
   * it is a student who can book themselves. Every deck has a signed-in
   * viewer, so there is no caller this costs.
   *
   * Note the supply-count consequence: a course whose only tutor is the
   * viewer is a zero-tutor deck *for them*, and `presentationFor` turns that
   * into demand capture rather than an empty list.
   */
  viewerUserId: string;
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
      takenTermName: term.name,
      scoreSampleCount: tutorCourse.scoreSampleCount,
      scorePosteriorMeanBp: tutorCourse.scorePosteriorMean,
      recentSilentExpiries: silentExpiries,
      tutorProfileId: tutorProfile.id,
      tutorName: user.name,
      headline: tutorProfile.headline,
      bio: tutorProfile.bio,
      takenUnderProfessorName: professor.name,
    })
    .from(tutorCourse)
    .innerJoin(term, eq(term.id, tutorCourse.takenTermId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .leftJoin(professor, eq(professor.id, tutorCourse.takenUnderProfessorId))
    .where(
      and(
        eq(tutorCourse.courseId, target.courseId),
        eq(tutorCourse.status, "active"),
        // Redundant with the course scope above, but a tutor profile is the
        // other way a row could belong to another campus.
        eq(tutorProfile.institutionId, params.institutionId),
        ne(tutorProfile.userId, params.viewerUserId),
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
    recentSilentExpiries: row.recentSilentExpiries,
  }));

  // Ranking is pure and knows only the scoring inputs, so the display fields
  // are re-attached afterwards rather than passed through `score.ts`.
  const display = new Map(rows.map((row) => [row.tutorCourseId, row]));

  const ranked: DeckCard[] = rankCandidates(candidates).map((scored) => {
    const row = display.get(scored.tutorCourseId)!;
    return {
      ...scored,
      tutorProfileId: row.tutorProfileId,
      tutorName: row.tutorName,
      headline: row.headline,
      bio: row.bio,
      takenUnderProfessorName: row.takenUnderProfessorName,
      takenTermName: row.takenTermName,
    };
  });

  return { candidates: ranked, presentation: presentationFor(ranked.length) };
}

/**
 * Requests this tutor let run out rather than passing on — a correlated scalar
 * subquery, so a tutor with no history costs nothing extra. Cast to `int`
 * because Postgres `count()` is a bigint and would arrive as a string.
 */
const silentExpiries = sql<number>`(
  select count(*)::int
  from ${matchRequest}
  where ${matchRequest.tutorCourseId} = ${tutorCourse.id}
    and ${matchRequest.status} = 'expired'
)`;

/** Approximate: two terms per academic year. Good enough for recency decay. */
function termsBetween(takenStartsOn: string, offeringStartsOn: string): number {
  const months =
    (new Date(offeringStartsOn).getTime() - new Date(takenStartsOn).getTime()) /
    (1000 * 60 * 60 * 24 * 30.44);
  return Math.max(0, Math.round(months / 6));
}
