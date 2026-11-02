import { and, asc, eq, exists, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  college,
  course,
  courseCodeAlias,
  courseOffering,
  demandSignal,
  enrollment,
  exam,
  institution,
  professor,
  term,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";
import { PERSONA_SECTION } from "@/server/modules/billing/fixtures";
import type { Actor } from "@/server/modules/identity/actor";
import { buildDeck } from "@/server/modules/matching/candidates";

export type CourseSummary = {
  courseId: string;
  code: string;
  title: string;
  department: string;
};

export type CollegeSummary = {
  collegeId: string;
  name: string;
};

export type OfferingSummary = {
  offeringId: string;
  section: string | null;
  professorName: string | null;
  termName: string;
};

export type CourseTickerItem = {
  courseId: string;
  code: string;
  title: string;
  tutorCount: number;
  nextExamOn: string | null;
};

const LAUNCH_CAMPUS_SLUG = "ua";

const currentCode = and(
  eq(courseCodeAlias.courseId, course.id),
  isNull(courseCodeAlias.validToTermId),
);

export async function currentTerm(institutionId: string) {
  const rows = await db
    .select({ id: term.id, name: term.name, startsOn: term.startsOn, endsOn: term.endsOn })
    .from(term)
    .where(
      and(
        eq(term.institutionId, institutionId),
        sql`current_date between ${term.startsOn} and ${term.endsOn}`,
      ),
    )
    .limit(1);

  return rows.at(0) ?? null;
}

export async function collegesWithCourses(institutionId: string): Promise<CollegeSummary[]> {
  return db
    .select({ collegeId: college.id, name: college.name })
    .from(college)
    .where(
      and(
        eq(college.institutionId, institutionId),
        exists(
          db
            .select({ id: course.id })
            .from(course)
            .where(
              and(
                eq(course.collegeId, college.id),
                eq(course.institutionId, institutionId),
                eq(course.isSeeded, true),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(college.sortOrder), asc(college.name));
}

export async function searchSeededCourses(params: {
  institutionId: string;
  query: string;
  collegeId?: string;
}): Promise<CourseSummary[]> {
  const needle = `%${params.query.trim()}%`;

  return db
    .select({
      courseId: course.id,
      code: courseCodeAlias.code,
      title: course.title,
      department: course.department,
    })
    .from(course)
    .innerJoin(courseCodeAlias, currentCode)
    .where(
      and(
        eq(course.institutionId, params.institutionId),
        eq(course.isSeeded, true),
        params.collegeId === undefined
          ? undefined
          : inArray(
              course.collegeId,
              db
                .select({ id: college.id })
                .from(college)
                .where(
                  and(
                    eq(college.id, params.collegeId),
                    eq(college.institutionId, params.institutionId),
                  ),
                ),
            ),
        params.query.trim().length === 0
          ? undefined
          : or(ilike(courseCodeAlias.code, needle), ilike(course.title, needle)),
      ),
    )
    .orderBy(courseCodeAlias.code)
    .limit(20);
}

export async function offeringsForCourse(params: {
  courseId: string;
  institutionId: string;
}): Promise<OfferingSummary[]> {
  return db
    .select({
      offeringId: courseOffering.id,
      section: courseOffering.section,
      professorName: professor.name,
      termName: term.name,
    })
    .from(courseOffering)
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .leftJoin(professor, eq(professor.id, courseOffering.professorId))
    .where(
      and(
        eq(courseOffering.courseId, params.courseId),
        eq(course.institutionId, params.institutionId),
        sql`current_date between ${term.startsOn} and ${term.endsOn}`,
        sql`${courseOffering.section} is distinct from ${PERSONA_SECTION}`,
      ),
    )
    .orderBy(courseOffering.section);
}

export async function launchCampusId(): Promise<string | null> {
  const rows = await db
    .select({ id: institution.id })
    .from(institution)
    .where(eq(institution.slug, LAUNCH_CAMPUS_SLUG))
    .limit(1);

  return rows.at(0)?.id ?? null;
}

export async function courseTicker(institutionId: string): Promise<CourseTickerItem[]> {
  const nextExamOn = sql<string | null>`(
    select min(${exam.occursOn})::text
    from ${exam}
    inner join ${courseOffering} on ${courseOffering.id} = ${exam.courseOfferingId}
    inner join ${term} on ${term.id} = ${courseOffering.termId}
    where ${courseOffering.courseId} = ${course.id}
      and ${exam.institutionId} = ${institutionId}
      and ${courseOffering.institutionId} = ${institutionId}
      and ${term.institutionId} = ${institutionId}
      and current_date between ${term.startsOn} and ${term.endsOn}
      and ${exam.occursOn} >= current_date
      and ${courseOffering.section} is distinct from ${PERSONA_SECTION}
  )`;

  return db
    .select({
      courseId: course.id,
      code: courseCodeAlias.code,
      title: course.title,
      tutorCount: sql<number>`count(distinct ${tutorProfile.id})::int`,
      nextExamOn,
    })
    .from(course)
    .innerJoin(courseCodeAlias, currentCode)
    .innerJoin(
      tutorCourse,
      and(
        eq(tutorCourse.courseId, course.id),
        eq(tutorCourse.institutionId, institutionId),
        eq(tutorCourse.status, "active"),
      ),
    )
    .innerJoin(
      tutorProfile,
      and(
        eq(tutorProfile.id, tutorCourse.tutorProfileId),
        eq(tutorProfile.institutionId, institutionId),
      ),
    )
    .where(
      and(
        eq(course.institutionId, institutionId),
        eq(course.isSeeded, true),
        eq(courseCodeAlias.institutionId, institutionId),
      ),
    )
    .groupBy(course.id, courseCodeAlias.code)
    .orderBy(courseCodeAlias.code);
}

export async function courseById(params: {
  courseId: string;
  institutionId: string;
}): Promise<CourseSummary | null> {
  const rows = await db
    .select({
      courseId: course.id,
      code: courseCodeAlias.code,
      title: course.title,
      department: course.department,
    })
    .from(course)
    .innerJoin(courseCodeAlias, currentCode)
    .where(and(eq(course.id, params.courseId), eq(course.institutionId, params.institutionId)))
    .limit(1);

  return rows.at(0) ?? null;
}

export type OfferingDetail = CourseSummary & OfferingSummary;

export async function offeringById(params: {
  offeringId: string;
  institutionId: string;
}): Promise<OfferingDetail | null> {
  const rows = await db
    .select({
      courseId: course.id,
      code: courseCodeAlias.code,
      title: course.title,
      department: course.department,
      offeringId: courseOffering.id,
      section: courseOffering.section,
      professorName: professor.name,
      termName: term.name,
    })
    .from(courseOffering)
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(courseCodeAlias, currentCode)
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .leftJoin(professor, eq(professor.id, courseOffering.professorId))
    .where(
      and(
        eq(courseOffering.id, params.offeringId),
        eq(course.institutionId, params.institutionId),
      ),
    )
    .limit(1);

  return rows.at(0) ?? null;
}

export async function professorsForCourse(params: {
  courseId: string;
  institutionId: string;
}): Promise<{ id: string; name: string }[]> {
  return db
    .selectDistinct({ id: professor.id, name: professor.name })
    .from(courseOffering)
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(professor, eq(professor.id, courseOffering.professorId))
    .where(
      and(
        eq(courseOffering.courseId, params.courseId),
        eq(course.institutionId, params.institutionId),
        eq(professor.institutionId, params.institutionId),
      ),
    )
    .orderBy(professor.name);
}

export async function termsForInstitution(
  institutionId: string,
): Promise<{ id: string; name: string; startsOn: string }[]> {
  return db
    .select({ id: term.id, name: term.name, startsOn: term.startsOn })
    .from(term)
    .where(
      and(eq(term.institutionId, institutionId), sql`${term.startsOn} <= current_date`),
    )
    .orderBy(sql`${term.startsOn} desc`);
}

export async function upcomingExams(offeringId: string) {
  return db
    .select({ id: exam.id, name: exam.name, occursOn: exam.occursOn })
    .from(exam)
    .where(and(eq(exam.courseOfferingId, offeringId), sql`${exam.occursOn} >= current_date`))
    .orderBy(exam.occursOn);
}

export async function enroll(params: {
  studentProfileId: string;
  institutionId: string;
  courseOfferingId: string;
}): Promise<void> {
  await db.insert(enrollment).values(params).onConflictDoNothing();
}

export async function awaitCoverage(params: {
  actor: Pick<Actor, "userId" | "institutionId" | "studentProfileId">;
  courseOfferingId: string;
}): Promise<boolean> {
  const deck = await buildDeck({
    courseOfferingId: params.courseOfferingId,
    institutionId: params.actor.institutionId,
    viewerUserId: params.actor.userId,
  });
  if (deck.candidates.length > 0) return false;

  const seat = {
    studentProfileId: params.actor.studentProfileId,
    institutionId: params.actor.institutionId,
    courseOfferingId: params.courseOfferingId,
  };
  await enroll(seat);
  await db
    .insert(demandSignal)
    .values(seat)
    .onConflictDoUpdate({
      target: [demandSignal.studentProfileId, demandSignal.courseOfferingId],
      set: { requestedAt: sql`now()`, notifiedAt: null },
    });
  return true;
}
