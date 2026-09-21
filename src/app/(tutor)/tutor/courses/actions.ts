"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireTutor } from "@/server/modules/identity/actor";
import { TutoringError, claimCourse } from "@/server/modules/tutoring/courses";
import { claimCourseInput } from "@/server/modules/tutoring/input";

export type ClaimState = { status: "idle" } | { status: "error"; message: string };

export async function claimCourseAction(
  _previous: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const tutor = await requireTutor();

  const professorId = formData.get("takenUnderProfessorId");

  const parsed = claimCourseInput.safeParse({
    courseId: formData.get("courseId"),
    takenTermId: formData.get("takenTermId"),

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

  revalidatePath("/tutor/courses");
  redirect("/tutor/courses");
}
