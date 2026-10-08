import { CardLink } from "@/components/card";
import { formatDay, formatTime } from "@/components/format";
import { Icon } from "@/components/icons";
import type { SessionListItem } from "@/server/modules/engagements/reads";
import { displayName } from "@/server/modules/identity/display-name";

export function SessionRow({ session }: { session: SessionListItem }) {
  const course = [session.courseCode ?? session.courseTitle, session.professorName]
    .filter(Boolean)
    .join(" · ");
  const status = statusFor(session);

  return (
    <CardLink href={`/sessions/${session.sessionId}`} className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {formatDay(session.scheduledAt)} at {formatTime(session.scheduledAt)}
        </p>
        <p className="truncate text-sm text-muted">{course}</p>
        <p className="truncate text-sm text-muted">
          {session.otherPartyRole === "tutor" ? "With " : ""}
          {displayName(session.otherPartyName, "tutor")}
          {session.status === "cancelled" ? " · cancelled" : ""}
          {session.status === "disputed" ? " · under review" : ""}
          {session.status === "scheduled" && session.location ? ` · ${session.location}` : ""}
        </p>
        {status ? <p className="text-sm text-accent">{status}</p> : null}
      </div>
      <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
    </CardLink>
  );
}

function statusFor(session: SessionListItem): string | null {
  const tutor = displayName(session.otherPartyName, "tutor");
  switch (session.action) {
    case "cancel":
    case "late_cancel":
      return `Confirmed on ${tutor}'s calendar`;
    case "confirm_or_deny":
      return "Waiting on your answer";
    case "awaiting_other_party":
      return `Waiting on ${tutor} to answer`;
  }
  return session.resolution === "both_confirmed" ? "Confirmed by both of you" : null;
}
