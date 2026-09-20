/**
 * The grade bar, and nothing else.
 *
 * **This module must never import the database, and that is load-bearing
 * rather than incidental.** A client component builds the grade picker from
 * `ELIGIBLE_GRADES`, and the bundler follows the import graph rather than the
 * symbol: one `db` import anywhere in this file's dependencies drags the
 * postgres driver into the browser bundle, and the build fails on `fs`, `net`
 * and `tls`. Re-exporting these from a module that does touch the database
 * would not help, because the graph is what is followed.
 *
 * `billing/pricing.ts` is safe in a client component for exactly the same
 * reason — see `src/components/README.md`, which treats that as a property to
 * preserve, not a coincidence. Typecheck and lint both pass when this is
 * violated; only `npm run build` catches it.
 *
 * The bar itself is from `schema.ts`: an A or A- in the course being claimed.
 * It lives in one place so the picker's options and the server's check cannot
 * disagree — the day the bar moves, a hardcoded list in a form would go on
 * telling a tutor they qualify when they no longer do.
 */

export const ELIGIBLE_GRADES = ["A+", "A", "A-"] as const;

export type EligibleGrade = (typeof ELIGIBLE_GRADES)[number];

/** Tolerant of case, padding, and the unicode minus a transcript pastes in. */
export function normaliseGrade(grade: string): string {
  return grade.trim().toUpperCase().replace("−", "-");
}

export function isEligibleGrade(grade: string): boolean {
  return (ELIGIBLE_GRADES as readonly string[]).includes(normaliseGrade(grade));
}
