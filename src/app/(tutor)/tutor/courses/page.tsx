import type { Metadata } from "next";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Field, Select } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { requireTutor } from "@/server/modules/identity/actor";
import {
  professorsForCourse,
  searchSeededCourses,
  termsForInstitution,
} from "@/server/modules/catalog/courses";
import {
  coursesForTutor,
  type TutorCourseClaim,
} from "@/server/modules/tutoring/courses";

import { ClaimForm } from "./claim-form";

export const metadata: Metadata = { title: "Your courses" };

/**
 * `(tutor, course)` is the core relationship — not `tutor`. Someone can be
 * excellent at Calc I and mediocre at Organic, so a claim is made one course
 * at a time, with the professor it was taken under.
 *
 * Two steps on one route: pick the course, then say how you took it. The
 * professor list depends on the course, and `?course=` keeps that dependency
 * on the server instead of shipping the whole catalog's instructors to a
 * phone.
 */
export default async function TutorCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string | string[] }>;
}) {
  const tutor = await requireTutor();
  const { course } = await searchParams;
  const wanted = typeof course === "string" ? course : undefined;

  const [claims, catalog] = await Promise.all([
    coursesForTutor(tutor),
    // The seeded weed-out courses, which is the whole claimable catalog.
    searchSeededCourses({ institutionId: tutor.institutionId, query: "" }),
  ]);

  const claimed = new Set(claims.map((claim) => claim.courseId));
  // A param is a string from a URL bar, not a course. It only counts if it is
  // in the catalog this campus can claim from.
  const claiming = wanted ? catalog.find((entry) => entry.courseId === wanted) : undefined;

  if (claiming) {
    const [terms, professors] = await Promise.all([
      termsForInstitution(tutor.institutionId),
      professorsForCourse({
        courseId: claiming.courseId,
        institutionId: tutor.institutionId,
      }),
    ]);

    return (
      <div className="flex max-w-xl flex-col gap-6">
        <PageHeader
          eyebrow={claiming.code}
          title={claiming.title}
          description="Tell us how you took it. Nothing goes live until a person has checked the grade."
        />
        <Card>
          <ClaimForm
            courseId={claiming.courseId}
            courseCode={claiming.code}
            terms={terms}
            professors={professors}
          />
        </Card>
      </div>
    );
  }

  const unclaimed = catalog.filter((entry) => !claimed.has(entry.courseId));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Courses you tutor"
        description="Students can only ask you for a course you have claimed, under the professor you took it with."
      />

      {claims.length === 0 ? (
        <EmptyState
          icon="book"
          title="No courses yet"
          description="Claim the first course you took and did well in. Requests arrive course by course, so this is what turns your inbox on."
        />
      ) : (
        <ul className="flex flex-col gap-4">
          {claims.map((claim) => (
            <li key={claim.id}>
              <ClaimCard claim={claim} />
            </li>
          ))}
        </ul>
      )}

      {unclaimed.length === 0 ? null : (
        <Card>
          {/* A plain GET: picking a course is navigation, not a mutation. */}
          <form className="flex flex-col gap-4" action="/tutor/courses" method="get">
            <Field
              id="claim-course"
              label="Add a course you took"
              hint="Only the courses this campus is live on, minus the ones you already have."
            >
              <Select id="claim-course" name="course" required defaultValue="">
                <option value="" disabled>
                  Pick a course
                </option>
                {unclaimed.map((entry) => (
                  <option key={entry.courseId} value={entry.courseId}>
                    {entry.code} — {entry.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" size="lg" className="sm:self-start">
              Continue
            </Button>
          </form>
        </Card>
      )}
    </div>
  );
}

function ClaimCard({ claim }: { claim: TutorCourseClaim }) {
  const history = [
    `Took it ${claim.takenTermName}`,
    claim.professorName ? `with Prof. ${claim.professorName}` : null,
    `· ${claim.gradeEarned}`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {claim.department}
      </p>
      <h2 className="text-lg font-semibold tracking-tight">
        {claim.courseCode ?? claim.courseTitle}
      </h2>
      {claim.courseCode ? (
        <p className="text-sm text-muted">{claim.courseTitle}</p>
      ) : null}
      <p className="text-sm text-muted">{history}</p>
      <p className="text-sm text-foreground">{statusCopy(claim.status)}</p>
    </Card>
  );
}

/**
 * The state of the claim, in words. Not a badge and not a score — this says
 * what the platform will do with the course, which is a mechanic, and every
 * one of these states is recoverable.
 */
function statusCopy(status: TutorCourseClaim["status"]): string {
  switch (status) {
    case "pending_verification":
      return "Waiting on verification. Students cannot see it or ask you for it yet.";
    case "active":
      return "Live. Students in this course can ask you.";
    case "winding_down":
      return "Winding down for graduation. No new students; packages you already have run out.";
    case "retired":
      return "Retired. You are not offered for this course.";
  }
}
