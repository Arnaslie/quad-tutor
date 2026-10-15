"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { failure } from "@/app/messages/action-state";
import type { ReportState } from "@/components/report-form";
import { formatMinor } from "@/server/modules/billing/pricing";
import { requireTutor } from "@/server/modules/identity/actor";
import { ratingReportInput } from "@/server/modules/messaging/input";
import { reportRating } from "@/server/modules/messaging/reports";
import { TutoringError, claimCourse, setCourseRate } from "@/server/modules/tutoring/courses";
import {
  claimCourseInput,
  setCourseRateInput,
  submitProofInput,
} from "@/server/modules/tutoring/input";
import { RATE_RULE } from "@/server/modules/tutoring/rate-rules";
import { VerificationError, submitProof } from "@/server/modules/tutoring/verification";

export type ClaimState = { status: "idle" } | { status: "error"; message: string };

export type RateState =
  | { status: "idle" }
  | { status: "saved"; message: string }
  | { status: "error"; message: string };

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

  let claimed: string;
  try {
    ({ tutorCourseId: claimed } = await claimCourse({ tutor, ...parsed.data }));
  } catch (error) {
    if (error instanceof TutoringError) return { status: "error", message: error.message };
    throw error;
  }

  revalidatePath("/tutor/courses");
  redirect(`/tutor/courses?proof=${claimed}`);
}

export async function submitProofAction(
  _previous: ClaimState,
  formData: FormData,
): Promise<ClaimState> {
  const tutor = await requireTutor();

  const parsed = submitProofInput.safeParse({
    tutorCourseId: formData.get("tutorCourseId"),
    kind: formData.get("kind"),
  });
  if (!parsed.success) return { status: "error", message: "Pick what you are sending." };

  const files = await Promise.all(
    formData
      .getAll("files")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0)
      .map(async (file) => new Uint8Array(await file.arrayBuffer())),
  );

  try {
    await submitProof({ tutor, ...parsed.data, files });
  } catch (error) {
    if (error instanceof VerificationError) return { status: "error", message: error.message };
    throw error;
  }

  revalidatePath("/tutor/courses");
  redirect("/tutor/courses");
}

export async function setCourseRateAction(
  _previous: RateState,
  formData: FormData,
): Promise<RateState> {
  const tutor = await requireTutor();

  const parsed = setCourseRateInput.safeParse({
    tutorCourseId: formData.get("tutorCourseId"),
    dollars: formData.get("dollars"),
  });
  if (!parsed.success) return { status: "error", message: RATE_RULE };

  try {
    await setCourseRate({ tutor, ...parsed.data });
  } catch (error) {
    if (error instanceof TutoringError) return { status: "error", message: error.message };
    throw error;
  }

  revalidatePath("/tutor/courses");
  return {
    status: "saved",
    message: `Saved. New requests and top-ups pay ${formatMinor(parsed.data.rateMinor)} a session. Packages you already agreed to keep their price.`,
  };
}

export async function reportRatingAction(
  _previous: ReportState,
  formData: FormData,
): Promise<ReportState> {
  const tutor = await requireTutor();
  const parsed = ratingReportInput.safeParse({
    sessionRatingId: formData.get("sessionRatingId"),
    reason: formData.get("reason"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Pick a reason." };
  }

  try {
    await reportRating({ actor: tutor, ...parsed.data });
  } catch (error) {
    return failure(error);
  }
  return { status: "sent" };
}
