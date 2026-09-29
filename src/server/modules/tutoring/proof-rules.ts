export const PROOF_KINDS = ["official_transcript", "screenshot"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

export const PROOF_KIND_LABEL: Record<ProofKind, string> = {
  official_transcript: "Official transcript (PDF)",
  screenshot: "Unofficial transcript screenshots",
};

export const MAX_SCREENSHOTS = 5;
export const MAX_PROOF_BYTES = 3_500_000;
export const MAX_PROOF_MB = MAX_PROOF_BYTES / 1_000_000;

export const PDF_TYPE = "application/pdf";
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const REJECTION_REASONS = [
  "grade_not_visible",
  "name_mismatch",
  "wrong_course_or_term",
  "grade_below_a_minus",
  "unreadable",
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export const REJECTION_REASON_LABEL: Record<RejectionReason, string> = {
  grade_not_visible: "Grade not visible",
  name_mismatch: "Name doesn't match",
  wrong_course_or_term: "Wrong course or term",
  grade_below_a_minus: "Grade below A-",
  unreadable: "Unreadable",
};

export const REJECTION_REASON_COPY: Record<RejectionReason, string> = {
  grade_not_visible: "The grade for this course wasn't visible in what you sent.",
  name_mismatch: "The name on the transcript didn't match the name on your account.",
  wrong_course_or_term:
    "The transcript showed a different course or term from the one you claimed.",
  grade_below_a_minus:
    "The grade on the transcript is below the A- this course needs. If you retook it or the grade was changed, send the record that shows it.",
  unreadable: "We couldn't read the file clearly enough to check it.",
};

export function proofProblem(
  kind: ProofKind,
  files: { type: string; size: number }[],
): string | null {
  if (files.length === 0) return "Add your transcript first.";

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_PROOF_BYTES) {
    return `That comes to more than ${MAX_PROOF_MB} MB. Send a smaller file.`;
  }

  if (kind === "official_transcript") {
    if (files.length !== 1 || files[0].type !== PDF_TYPE) {
      return "Send the transcript as the one PDF you downloaded.";
    }
    return null;
  }

  if (files.length > MAX_SCREENSHOTS) return `Send at most ${MAX_SCREENSHOTS} screenshots.`;
  if (!files.every((file) => (IMAGE_TYPES as readonly string[]).includes(file.type))) {
    return "Screenshots have to be images (JPEG, PNG or WebP).";
  }
  return null;
}
