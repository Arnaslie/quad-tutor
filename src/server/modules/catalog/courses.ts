/**
 * Course catalog reads.
 *
 * Course selection is the primary input of a sub-45-second intake, so these
 * queries exist to make a type-ahead cheap: seeded courses only, current term
 * only, code resolved through the alias table rather than stored on the course.
 *
 * Never key on the code string. `courseCodeAlias` carries the term validity
 * window; the durable entity is `course`.
 */

import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  enrollment,
  exam,
  professor,
  term,
} from "@/server/db/schema";

export type CourseSummary = {
  courseId: string;
  code: string;
  title: string;
  department: string;
};

export type OfferingSummary = {
  offeringId: string;
  section: string | null;
  professorName: string | null;
  termName: string;
};

/** The alias with no end term is the code the course goes by right now. */
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

/**
 * Type-ahead over the seeded weed-out courses. Matching on either the code or
 * the title is what lets a student type "calc" or "MATH 125" and land in the
 * same place.
 */
export async function searchSeededCourses(params: {
  institutionId: string;
  query: string;
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
        params.query.trim().length === 0
          ? undefined
          : or(ilike(courseCodeAlias.code, needle), ilike(course.title, needle)),
      ),
    )
    .orderBy(courseCodeAlias.code)
    .limit(20);
}

/**
 * Section and professor are a required second step of intake — an instructor
 * change invalidates the entire value proposition, so the system has to know
 * which one the student has.
 */
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
      ),
    )
    .orderBy(courseOffering.section);
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

/**
 * Every professor who has *ever* taught this course, not just this term's.
 *
 * `offeringsForCourse` is deliberately current-term only — a student picks the
 * section they are sitting in now. A tutor is answering a different question:
 * who taught it when *they* took it, which is usually a past term and is the
 * whole basis of the wedge. Same table, opposite time window.
 */
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

/**
 * Terms already under way or finished, newest first — "when did you take it".
 * Future terms are excluded because nobody has taken a course in one yet.
 */
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

/** Packages anchor to these. The next one that has not happened yet is the default. */
export async function upcomingExams(offeringId: string) {
  return db
    .select({ id: exam.id, name: exam.name, occursOn: exam.occursOn })
    .from(exam)
    .where(and(eq(exam.courseOfferingId, offeringId), sql`${exam.occursOn} >= current_date`))
    .orderBy(exam.occursOn);
}

/** Idempotent: re-running intake for the same offering must not duplicate. */
export async function enroll(params: {
  studentProfileId: string;
  courseOfferingId: string;
}): Promise<void> {
  await db.insert(enrollment).values(params).onConflictDoNothing();
}
