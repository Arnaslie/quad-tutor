export const SESSION_MINUTES = 60;

export const CONFIRMATION_WINDOW_HOURS = 24;

export const LATE_CANCEL_HOURS = 12;

export type AttendanceAnswers = {
  studentConfirmedAt: Date | null;
  tutorConfirmedAt: Date | null;
  studentDeniedAt: Date | null;
  tutorDeniedAt: Date | null;
  confirmationWindowEndsAt: Date | null;
};

export type Settlement = {
  resolution:
    | "both_confirmed"
    | "auto_released"
    | "disputed"
    | "resolved_not_attended";

  delivered: boolean;

  studentFact: "attended" | "no_showed" | null;
};

const answered = (confirmedAt: Date | null, deniedAt: Date | null) =>
  confirmedAt !== null || deniedAt !== null;

export function settle(answers: AttendanceAnswers, now: Date): Settlement | null {
  const studentSaysYes = answers.studentConfirmedAt !== null;
  const tutorSaysYes = answers.tutorConfirmedAt !== null;
  const studentSaysNo = answers.studentDeniedAt !== null;
  const tutorSaysNo = answers.tutorDeniedAt !== null;

  if ((studentSaysYes && tutorSaysNo) || (tutorSaysYes && studentSaysNo)) {
    return { resolution: "disputed", delivered: false, studentFact: null };
  }

  if (studentSaysYes && tutorSaysYes) {
    return { resolution: "both_confirmed", delivered: true, studentFact: "attended" };
  }

  if (studentSaysNo && tutorSaysNo) {
    return {
      resolution: "resolved_not_attended",
      delivered: false,
      studentFact: null,
    };
  }

  const windowEndsAt = answers.confirmationWindowEndsAt;
  const lapsed = windowEndsAt !== null && now.getTime() >= windowEndsAt.getTime();
  if (!lapsed) return null;

  if (studentSaysNo) {
    return {
      resolution: "resolved_not_attended",
      delivered: false,
      studentFact: null,
    };
  }

  return {
    resolution: "auto_released",
    delivered: true,

    studentFact: studentSaysYes ? "attended" : tutorSaysNo ? "no_showed" : null,
  };
}

export function isLateCancel(scheduledAt: Date, now: Date): boolean {
  return scheduledAt.getTime() - now.getTime() < LATE_CANCEL_HOURS * 60 * 60 * 1000;
}

export function sessionEndsAt(scheduledAt: Date, durationMinutes: number): Date {
  return new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000);
}

export type ViewerAction =
  | "cancel"
  | "late_cancel"
  | "confirm_or_deny"
  | "awaiting_other_party"
  | "awaiting_review"
  | "none";

export function viewerAction(params: {
  status: "scheduled" | "completed" | "cancelled" | "disputed";
  scheduledAt: Date;
  durationMinutes: number;
  answers: AttendanceAnswers;
  viewer: "student" | "tutor";
  now: Date;
}): ViewerAction {
  if (params.status === "disputed") return "awaiting_review";
  if (params.status !== "scheduled") return "none";

  const endsAt = sessionEndsAt(params.scheduledAt, params.durationMinutes);
  if (params.now.getTime() < endsAt.getTime()) {
    if (params.now.getTime() >= params.scheduledAt.getTime()) return "none";
    return isLateCancel(params.scheduledAt, params.now) ? "late_cancel" : "cancel";
  }

  const mine =
    params.viewer === "student"
      ? answered(params.answers.studentConfirmedAt, params.answers.studentDeniedAt)
      : answered(params.answers.tutorConfirmedAt, params.answers.tutorDeniedAt);

  return mine ? "awaiting_other_party" : "confirm_or_deny";
}

export const REMINDER_HOURS = 24;

export function reminderDueAt(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() - REMINDER_HOURS * 60 * 60 * 1000);
}

export function remindedAtForNewBooking(scheduledAt: Date, now = new Date()): Date | null {
  return reminderDueAt(scheduledAt) <= now ? now : null;
}
