import { Field, Input } from "@/components/field";
import { Icon } from "@/components/icons";

export function StudentNoteField({ tutorName }: { tutorName: string }) {
  return (
    <Field
      id="student-note"
      label={`Note for ${tutorName} (optional)`}
      hint="What you want to cover, or anything they should bring."
    >
      <Input
        id="student-note"
        name="studentNote"
        maxLength={200}
        placeholder="Chapter 4 problem set, question 7"
      />
    </Field>
  );
}

export function MeetingSpot({
  tutorName,
  location,
}: {
  tutorName: string;
  location: string | null;
}) {
  return (
    <div className="flex gap-3 rounded-xl bg-surface-sunken px-4 py-3 text-sm">
      <Icon name="pin" className="mt-0.5 size-[18px] shrink-0 text-muted" />
      {location ? (
        <p className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">You meet at {location}</span>
          <span className="text-muted">
            {tutorName} chose this spot. If it changes, you get an email.
          </span>
        </p>
      ) : (
        <p className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">
            {tutorName} has not set a meeting spot yet
          </span>
          <span className="text-muted">
            It shows on your session page as soon as they do.
          </span>
        </p>
      )}
    </div>
  );
}
