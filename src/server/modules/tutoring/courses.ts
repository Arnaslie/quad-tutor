import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  professor,
  term,
  tutorCourse,
} from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";

import { isEligibleGrade, normaliseGrade } from "./grades";

export class TutoringError extends Error {}

export type TutorCourseClaim = {
  id: string;
  courseId: string;

  courseCode: string | null;
  courseTitle: string;
  department: string;
  gradeEarned: string;
  takenTermName: string;
  professorName: string | null;
  status: "pending_verification" | "active" | "winding_down" | "retired";
  verifiedAt: Date | null;
};

export async function coursesForTutor(tutor: TutorActor): Promise<TutorCourseClaim[]> {
  return db
    .select({
      id: tutorCourse.id,
      courseId: course.id,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      department: course.department,
      gradeEarned: tutorCourse.gradeEarned,
      takenTermName: term.name,
      professorName: professor.name,
      status: tutorCourse.status,
      verifiedAt: tutorCourse.verifiedAt,
    })
    .from(tutorCourse)
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .innerJoin(term, eq(term.id, tutorCourse.takenTermId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .leftJoin(professor, eq(professor.id, tutorCourse.takenUnderProfessorId))
    .where(
      and(
        eq(tutorCourse.tutorProfileId, tutor.tutorProfileId),

        eq(course.institutionId, tutor.institutionId),
      ),
    )
    .orderBy(asc(courseCodeAlias.code));
}

export async function claimCourse(params: {
  tutor: TutorActor;
  courseId: string;
  takenTermId: string;
  takenUnderProfessorId?: string | null;
  gradeEarned: string;
}): Promise<{ tutorCourseId: string }> {
  if (!isEligibleGrade(params.gradeEarned)) {
    throw new TutoringError(
      "Tutoring a course takes an A or A- in it. Claim a different course.",
    );
  }

  const campus = params.tutor.institutionId;
  const professorId = params.takenUnderProfessorId ?? null;

  const [courseRow, termRow, professorRow] = await Promise.all([
    db
      .select({ id: course.id })
      .from(course)
      .where(and(eq(course.id, params.courseId), eq(course.institutionId, campus)))
      .limit(1),
    db
      .select({ id: term.id })
      .from(term)
      .where(and(eq(term.id, params.takenTermId), eq(term.institutionId, campus)))
      .limit(1),
    professorId === null
      ? []
      : db
          .select({ id: professor.id })
          .from(professor)
          .where(and(eq(professor.id, professorId), eq(professor.institutionId, campus)))
          .limit(1),
  ]);

  if (!courseRow.at(0)) throw new TutoringError("That course is not in this catalog.");
  if (!termRow.at(0)) throw new TutoringError("That term is not in this catalog.");

  if (professorId !== null && !professorRow.at(0)) {
    throw new TutoringError("That professor is not in this catalog.");
  }

  const created = await db
    .insert(tutorCourse)
    .values({
      tutorProfileId: params.tutor.tutorProfileId,
      courseId: params.courseId,
      takenTermId: params.takenTermId,
      takenUnderProfessorId: professorId,
      gradeEarned: normaliseGrade(params.gradeEarned),
      status: "pending_verification",
    })
    .onConflictDoNothing()
    .returning({ id: tutorCourse.id });

  const inserted = created.at(0);
  if (inserted) return { tutorCourseId: inserted.id };

  const existing = await db
    .select({ id: tutorCourse.id })
    .from(tutorCourse)
    .where(
      and(
        eq(tutorCourse.tutorProfileId, params.tutor.tutorProfileId),
        eq(tutorCourse.courseId, params.courseId),
      ),
    )
    .limit(1);

  const already = existing.at(0);
  if (!already) throw new TutoringError("That claim could not be saved.");
  throw new TutoringError("You have already claimed this course.");
}
