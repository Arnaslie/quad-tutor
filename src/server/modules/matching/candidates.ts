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

export const REQUEST_EXPIRY_HOURS = 12;

export type DeckCard = ScoredCandidate & {
  tutorProfileId: string;
  tutorName: string;
  headline: string | null;
  bio: string | null;

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

export async function buildDeck(params: {
  courseOfferingId: string;
  institutionId: string;

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

const silentExpiries = sql<number>`(
  select count(*)::int
  from ${matchRequest}
  where ${matchRequest.tutorCourseId} = ${tutorCourse.id}
    and ${matchRequest.status} = 'expired'
)`;

function termsBetween(takenStartsOn: string, offeringStartsOn: string): number {
  const months =
    (new Date(offeringStartsOn).getTime() - new Date(takenStartsOn).getTime()) /
    (1000 * 60 * 60 * 24 * 30.44);
  return Math.max(0, Math.round(months / 6));
}
