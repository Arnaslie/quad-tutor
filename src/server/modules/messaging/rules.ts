export const MESSAGE_MAX_LENGTH = 2000;
export const REPORT_NOTE_MAX_LENGTH = 1000;

export const SENDS_PER_HOUR = 30;
export const ALERT_GAP_MINUTES = 15;
export const PREVIEW_LENGTH = 80;

export const THREAD_SIDES = ["student", "tutor"] as const;
export type ThreadSide = (typeof THREAD_SIDES)[number];

export const REPORT_REASONS = ["harassment", "spam", "safety", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  harassment: "Harassment",
  spam: "Spam",
  safety: "I feel unsafe",
  other: "Something else",
};

export const REPORT_OUTCOMES = ["no_action", "warned", "escalated"] as const;
export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];

export const REPORT_OUTCOME_LABEL: Record<ReportOutcome, string> = {
  no_action: "No action needed",
  warned: "Warned the sender",
  escalated: "Escalated",
};

export const DELETED_USER = "Deleted user";

export function otherSide(side: ThreadSide): ThreadSide {
  return side === "student" ? "tutor" : "student";
}

export function previewLine(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  if (line.length <= PREVIEW_LENGTH) return line;
  return `${line.slice(0, PREVIEW_LENGTH - 1).trimEnd()}…`;
}
