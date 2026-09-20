/**
 * The attendance rules. Pure — no I/O, no ORM, no clock beyond the `now` the
 * caller passes — so the adversarial case can be reasoned about without a
 * database, the same way `pricing.ts` and `standing.ts` are.
 *
 * Mutual confirmation is deliberately adversarial and docs/decisions.md is
 * honest about it: under a prepaid package the tutor wants the session marked
 * attended (they get paid) and the student is better off denying it (the
 * session returns to their package). The no-video decision is what makes this
 * the weak point, so the rules below are written to be defensible rather than
 * clever:
 *
 *   - **Money defaults; facts do not.** A lapsed window releases payment
 *     (`auto_released`), because leaving a tutor unpaid on a student's silence
 *     destroys the scarce side of the marketplace. It does *not* manufacture an
 *     `attended` reliability fact out of that silence — reliability is
 *     timestamped facts only, and "nobody answered" is not a fact about
 *     anyone's behaviour.
 *   - **Disagreement never resolves itself.** One side saying it happened and
 *     the other saying it did not is a dispute, settled by a human at launch
 *     volume. No amount of waiting converts a contested session into a paid one.
 *   - **Prevention comes first.** The T-12h nudge and the free-cancel boundary
 *     (`LATE_CANCEL_HOURS`) are the same moment on purpose: the last prompt to
 *     confirm you are coming is also the last chance to back out for free.
 *
 * The two answers each party can give are "it happened" (a confirm timestamp)
 * and "it did not" (a deny timestamp). A tutor's denial means one specific
 * thing — *the student did not show up* — because a tutor who cannot make it
 * cancels instead. A student's denial means the session did not happen, for
 * whatever reason. That asymmetry is what lets a `no_showed` fact be written
 * without asking anyone for a subjective read.
 */

/**
 * How long a session runs. Lives here rather than beside the booking code
 * because it is a fact about the product that a client form needs as readily
 * as the server does — and this module imports nothing, so a form can have it
 * without dragging the database into the browser bundle (see CLAUDE.md).
 */
export const SESSION_MINUTES = 60;

/** How long after a session ends both parties have to answer. */
export const CONFIRMATION_WINDOW_HOURS = 24;

/**
 * Inside this, a cancellation is late. Matched to the T-12h confirm nudge and
 * to the 12h booking lead time in `purchase.ts`: cancel vs late-cancel is a
 * timestamp comparison, never a judgement about why.
 */
export const LATE_CANCEL_HOURS = 12;

export type AttendanceAnswers = {
  studentConfirmedAt: Date | null;
  tutorConfirmedAt: Date | null;
  studentDeniedAt: Date | null;
  tutorDeniedAt: Date | null;
  confirmationWindowEndsAt: Date | null;
};

/** One of the `attendance_resolution` enum values, decided without a database. */
export type Settlement = {
  resolution:
    | "both_confirmed"
    | "auto_released"
    | "disputed"
    | "resolved_not_attended";
  /** True when the tutor is paid and the session counts against the package. */
  delivered: boolean;
  /**
   * The reliability fact to append for the *student*, or null when nothing is
   * actually known. Null is the common case and that is intentional.
   */
  studentFact: "attended" | "no_showed" | null;
};

const answered = (confirmedAt: Date | null, deniedAt: Date | null) =>
  confirmedAt !== null || deniedAt !== null;

/**
 * What this session settles to right now, or null if it is still legitimately
 * open. Callers settle on every answer and again on the sweep; this function
 * is the only place the outcome is decided.
 */
export function settle(answers: AttendanceAnswers, now: Date): Settlement | null {
  const studentSaysYes = answers.studentConfirmedAt !== null;
  const tutorSaysYes = answers.tutorConfirmedAt !== null;
  const studentSaysNo = answers.studentDeniedAt !== null;
  const tutorSaysNo = answers.tutorDeniedAt !== null;

  // Contested. Never settles on its own, whatever the clock says.
  if ((studentSaysYes && tutorSaysNo) || (tutorSaysYes && studentSaysNo)) {
    return { resolution: "disputed", delivered: false, studentFact: null };
  }

  if (studentSaysYes && tutorSaysYes) {
    // The one case where attendance is a fact both parties put their name to.
    return { resolution: "both_confirmed", delivered: true, studentFact: "attended" };
  }

  // Agreed it did not happen. The session goes back to the package, no money
  // moves, and nobody is assigned fault — the two denials mean different
  // things and neither corroborates the other.
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

  // An uncontested student denial returns the session. The tutor had the whole
  // window to object; if they had, this would be a dispute above.
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
    // The student's own confirmation is a fact even when the tutor never
    // answered. An uncontested tutor no-show report is held to exactly the
    // same evidentiary standard the money already defaults to. Silence from
    // both sides says nothing, so it records nothing.
    studentFact: studentSaysYes ? "attended" : tutorSaysNo ? "no_showed" : null,
  };
}

/** Cancel vs late-cancel. A comparison, not a judgement. */
export function isLateCancel(scheduledAt: Date, now: Date): boolean {
  return scheduledAt.getTime() - now.getTime() < LATE_CANCEL_HOURS * 60 * 60 * 1000;
}

export function sessionEndsAt(scheduledAt: Date, durationMinutes: number): Date {
  return new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000);
}

/**
 * The one thing this viewer can do about this session right now. The UI reads
 * this rather than re-deriving it from six nullable timestamps, so the student
 * view and the tutor view cannot drift apart.
 */
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
    // Cancelling is only offered up to the start time; after that the session
    // is over as far as the product is concerned and attendance decides it.
    if (params.now.getTime() >= params.scheduledAt.getTime()) return "none";
    return isLateCancel(params.scheduledAt, params.now) ? "late_cancel" : "cancel";
  }

  const mine =
    params.viewer === "student"
      ? answered(params.answers.studentConfirmedAt, params.answers.studentDeniedAt)
      : answered(params.answers.tutorConfirmedAt, params.answers.tutorDeniedAt);

  return mine ? "awaiting_other_party" : "confirm_or_deny";
}

/**
 * When the T-12h nudge is due. Prevention is the first line and the ordering
 * (confirm, then auto-release, then anything punitive) is a product principle.
 */
export function reminderDueAt(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() - LATE_CANCEL_HOURS * 60 * 60 * 1000);
}
