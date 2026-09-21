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
  courseOfferingId: string;
}): Promise<void> {
  await db.insert(enrollment).values(params).onConflictDoNothing();
}
