export const ELIGIBLE_GRADES = ["A+", "A", "A-"] as const;

export type EligibleGrade = (typeof ELIGIBLE_GRADES)[number];

export function normaliseGrade(grade: string): string {
  return grade.trim().toUpperCase().replace("−", "-");
}

export function isEligibleGrade(grade: string): boolean {
  return (ELIGIBLE_GRADES as readonly string[]).includes(normaliseGrade(grade));
}
