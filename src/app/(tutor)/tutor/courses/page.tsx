import type { Metadata } from "next";

import { Button, ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Field, Select } from "@/components/field";
import { PageHeader } from "@/components/page-header";
import { RatingLine } from "@/components/rating";
import { ReportForm } from "@/app/messages/[threadId]/report-form";
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
import {
  PROOF_KIND_LABEL,
  REJECTION_REASON_COPY,
} from "@/server/modules/tutoring/proof-rules";
import { cardRatings, notesForTutor, type CardRatings, type TutorNote } from "@/server/modules/ratings/reads";

import { reportRatingAction } from "./actions";
import { ClaimForm } from "./claim-form";
import { ProofForm } from "./proof-form";

export const metadata: Metadata = { title: "Your courses" };

export default async function TutorCoursesPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string | string[]; proof?: string | string[] }>;
}) {
  const tutor = await requireTutor();
  const { course, proof } = await searchParams;
  const wanted = typeof course === "string" ? course : undefined;

  const [claims, catalog] = await Promise.all([
    coursesForTutor(tutor),

    searchSeededCourses({ institutionId: tutor.institutionId, query: "" }),
  ]);

  const claimed = new Set(claims.map((claim) => claim.courseId));

  const proving = claims.find((claim) => claim.id === proof && needsProof(claim));
  if (proving) {
    const label = proving.courseCode ?? proving.courseTitle;
    return (
      <div className="flex max-w-xl flex-col gap-6">
        <PageHeader
          eyebrow={label}
          title="Show us the grade"
          description={`A person checks your ${label} grade against your UA transcript before students can see you for it.`}
        />
        {proving.status === "rejected" && proving.rejectionReason ? (
          <RejectionNote reason={proving.rejectionReason} />
        ) : null}
        <Card>
          <ProofForm tutorCourseId={proving.id} courseCode={label} />
        </Card>
      </div>
    );
  }

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
  const [ratings, notes] = await Promise.all([
    cardRatings(
      tutor.institutionId,
      claims.map((claim) => claim.id),
    ),
    notesForTutor(tutor),
  ]);

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
              <ClaimCard claim={claim} ratings={ratings.get(claim.id)} />
            </li>
          ))}
        </ul>
      )}

      {claims.length === 0 ? null : <StudentNotes notes={notes} />}

      {unclaimed.length === 0 ? null : (
        <Card>

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

function StudentNotes({ notes }: { notes: TutorNote[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">What students wrote</h2>
        <p className="text-sm text-muted">
          Notes show up here once a session&apos;s rating window has closed, without a name or a date.
        </p>
      </div>
      {notes.length === 0 ? (
        <Card className="text-sm text-muted">No notes yet.</Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.ratingId}>
              <Card className="flex flex-col gap-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">{note.courseLabel}</p>
                <p className="whitespace-pre-wrap text-sm">{note.note}</p>
                {note.reported ? (
                  <p className="text-sm text-muted">Reported. Waiting for review.</p>
                ) : (
                  <details className="rounded-xl border border-border">
                    <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium text-muted marker:content-none">
                      Report this note
                    </summary>
                    <div className="border-t border-border p-3">
                      <ReportForm
                        action={reportRatingAction}
                        field="sessionRatingId"
                        value={note.ratingId}
                        label="Why are you reporting it?"
                        hint="Someone on the Quad Tutor team reads it and can remove the rating."
                        sent="Reported. Someone on the Quad Tutor team will read it."
                      />
                    </div>
                  </details>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ClaimCard({ claim, ratings }: { claim: TutorCourseClaim; ratings?: CardRatings }) {
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
      {claim.proofKind ? (
        <p className="text-sm text-muted">Proof: {PROOF_KIND_LABEL[claim.proofKind]}</p>
      ) : null}
      <p className="text-sm text-foreground">{statusCopy(claim)}</p>
      <div className="flex flex-col gap-1 text-sm">
        <RatingLine rating={ratings?.courseRating ?? null} empty="New in this course" />
        <RatingLine
          rating={ratings?.overallRating ?? null}
          empty="New tutor"
          label="Overall"
          secondary
        />
      </div>
      {claim.status === "rejected" && claim.rejectionReason ? (
        <RejectionNote reason={claim.rejectionReason} />
      ) : null}
      {needsProof(claim) ? (
        <ButtonLink href={`/tutor/courses?proof=${claim.id}`} className="sm:self-start">
          {claim.status === "rejected" ? "Upload a new copy" : "Upload your transcript"}
        </ButtonLink>
      ) : null}
    </Card>
  );
}

function RejectionNote({ reason }: { reason: keyof typeof REJECTION_REASON_COPY }) {
  return (
    <p className="rounded-xl bg-surface-sunken p-3 text-sm text-foreground">
      {REJECTION_REASON_COPY[reason]} This is about the paperwork, nothing else: send a new
      copy and it goes straight back in the queue.
    </p>
  );
}

function needsProof(claim: TutorCourseClaim): boolean {
  return (
    claim.status === "rejected" || (claim.status === "pending_verification" && !claim.hasProof)
  );
}

function statusCopy(claim: TutorCourseClaim): string {
  switch (claim.status) {
    case "pending_verification":
      return claim.hasProof
        ? "Proof sent. A person is checking it; students cannot see this course yet."
        : "Needs your transcript before a person can check it. Students cannot see it yet.";
    case "rejected":
      return "We couldn't confirm the grade from the file you sent. Students cannot see it yet.";
    case "active":
      return "Live. Students in this course can ask you.";
    case "winding_down":
      return "Winding down for graduation. No new students; packages you already have run out.";
    case "retired":
      return "Retired. You are not offered for this course.";
  }
}
