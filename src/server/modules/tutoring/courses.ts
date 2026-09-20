/**
 * The supply side of the core relationship.
 *
 * `(tutor, course)` is the entity this product is built on, not `tutor` —
 * someone can be excellent at Calc I and mediocre at Organic, and the quality
 * score is per course for exactly that reason. This module is where a tutor
 * asserts one of those relationships and where their existing ones are read
 * back.
 *
 * A claim always lands `pending_verification`. Nothing in here can make a
 * tutor `active`: that takes a human looking at a transcript screenshot, and a
 * path from "I say I got an A" to "shown in a deck" without one is the whole
 * verification story quietly skipped. `buildDeck` filters on `active`, so an
 * unverified claim is invisible to students by construction.
 */

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

// Deliberately not re-exported: this file imports `db`, so anything a client
// component needs must be imported from `./grades` directly or the postgres
// driver follows it into the browser bundle. See that file's header.
import { isEligibleGrade, normaliseGrade } from "./grades";

export class TutoringError extends Error {}

export type TutorCourseClaim = {
  id: string;
  courseId: string;
  /** Null between renumberings; render the title when it is. */
  courseCode: string | null;
  courseTitle: string;
  department: string;
  gradeEarned: string;
  takenTermName: string;
  professorName: string | null;
  status: "pending_verification" | "active" | "winding_down" | "retired";
  verifiedAt: Date | null;
};

/** Every course this tutor has claimed, whatever state the claim is in. */
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
        // Redundant with the tutor profile, and kept anyway: a course is the
        // other way a row here could belong to another campus.
        eq(course.institutionId, tutor.institutionId),
      ),
    )
    .orderBy(asc(courseCodeAlias.code));
}

/**
 * Claim a course.
 *
 * Every id in here arrives from a `<select>` and is therefore untrusted: each
 * one is checked against the tutor's own campus before anything is written.
 * The tenant key comes from the actor, never from the form.
 */
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
  // Taking it under a recorded professor is optional; naming one that is not
  // on this campus is not.
  if (professorId !== null && !professorRow.at(0)) {
    throw new TutoringError("That professor is not in this catalog.");
  }

  // `(tutorProfileId, courseId)` is unique. Letting the index decide rather
  // than checking first is what makes a double submit safe: the second insert
  // finds nothing to do instead of racing past a check that just passed.
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
