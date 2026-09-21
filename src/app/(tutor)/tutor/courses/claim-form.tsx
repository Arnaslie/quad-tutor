"use client";

import { useActionState, useId } from "react";

import { Button, ButtonLink } from "@/components/button";
import { Field, Select } from "@/components/field";

import { ELIGIBLE_GRADES } from "@/server/modules/tutoring/grades";

import { claimCourseAction, type ClaimState } from "./actions";

const INITIAL: ClaimState = { status: "idle" };

export function ClaimForm({
  courseId,
  courseCode,
  terms,
  professors,
}: {
  courseId: string;
  courseCode: string;
  terms: { id: string; name: string }[];
  professors: { id: string; name: string }[];
}) {
  const [state, submit, pending] = useActionState(claimCourseAction, INITIAL);
  const termId = useId();
  const professorId = useId();
  const gradeId = useId();

  return (
    <form action={submit} className="flex flex-col gap-5">
      <input type="hidden" name="courseId" value={courseId} />

      <Field
        id={termId}
        label="When did you take it?"
        error={state.status === "error" ? state.message : undefined}
      >
        <Select id={termId} name="takenTermId" required defaultValue="">
          <option value="" disabled>
            Pick a term
          </option>
          {terms.map((term) => (
            <option key={term.id} value={term.id}>
              {term.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={professorId}
        label="Who taught it?"
        hint="This is what a student is really matching on. Leave it blank if you are not sure."
      >
        <Select id={professorId} name="takenUnderProfessorId" defaultValue="">
          <option value="">Not listed / not sure</option>
          {professors.map((professor) => (
            <option key={professor.id} value={professor.id}>
              {professor.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        id={gradeId}
        label="What did you get?"
        hint={`Tutoring ${courseCode} takes an A or A-. A person checks this against your transcript before students see you.`}
      >
        <Select id={gradeId} name="gradeEarned" required defaultValue="">
          <option value="" disabled>
            Pick a grade
          </option>
          {ELIGIBLE_GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {grade}
            </option>
          ))}
        </Select>
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row-reverse sm:justify-end">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Adding…" : `Add ${courseCode}`}
        </Button>
        <ButtonLink href="/tutor/courses" variant="secondary" size="lg">
          Back
        </ButtonLink>
      </div>
    </form>
  );
}
