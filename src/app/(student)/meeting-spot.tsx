import { Icon } from "@/components/icons";

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
            {tutorName} chose this spot. If it changes, your session page shows the new one.
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
