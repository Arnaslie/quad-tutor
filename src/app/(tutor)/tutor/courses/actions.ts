"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireTutor } from "@/server/modules/identity/actor";
import { TutoringError, claimCourse } from "@/server/modules/tutoring/courses";
import { claimCourseInput } from "@/server/modules/tutoring/input";

export type ClaimState = { status: "idle" } | { status: "error"; message: string };

/**
 * Claim a course.
 *
 * Every id here came out of a `<select>` and is worth exactly nothing on its
 * own — `claimCourse` re-checks each one against this tutor's campus. What
 * this function must not do is take the campus from the form.
 */
export async function claimCourseAction(
  _previous: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const tutor = await requireTutor();

  const professorId = formData.get("takenUnderProfessorId");

  const parsed = claimCourseInput.safeParse({
    courseId: formData.get("courseId"),
    takenTermId: formData.get("takenTermId"),
    // The picker's "not listed" option posts an empty string; the column is
    // nullable because a course may have no instructor on record for a term.
    takenUnderProfessorId: professorId === "" ? null : professorId,
    gradeEarned: formData.get("gradeEarned"),
  });

  if (!parsed.success) {
    return { status: "error", message: "Fill in the course, the term and the grade." };
  }

  try {
    await claimCourse({ tutor, ...parsed.data });
  } catch (error) {
    if (error instanceof TutoringError) return { status: "error", message: error.message };
    throw error;
  }

  // Outside the try: `redirect` signals by throwing, and catching it here
  // would turn a successful claim into an error message.
  revalidatePath("/tutor/courses");
  redirect("/tutor/courses");
}
