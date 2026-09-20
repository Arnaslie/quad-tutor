import { CardLink } from "@/components/card";
import { formatDay, formatTime } from "@/components/format";
import { Icon } from "@/components/icons";
import type { SessionListItem } from "@/server/modules/engagements/reads";
import { displayName } from "@/server/modules/identity/display-name";

/**
 * One row on the session board. A server component — the whole row is a link,
 * and the actions live on the session itself where there is room to disclose
 * what they do.
 *
 * The course context leads, because on this product "MATH 125 with Prof.
 * Doyle" is the thing a student recognises, not a date.
 */
export function SessionRow({ session }: { session: SessionListItem }) {
  const course = [session.courseCode ?? session.courseTitle, session.professorName]
    .filter(Boolean)
    .join(" · ");

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
        </p>
      </div>
      <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
    </CardLink>
  );
}
