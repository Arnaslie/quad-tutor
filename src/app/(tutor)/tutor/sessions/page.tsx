import type { Metadata } from "next";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDayTime } from "@/components/format";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { requireTutor } from "@/server/modules/identity/actor";
import {
  sessionBoardForTutor,
  type SessionListItem,
} from "@/server/modules/engagements/reads";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { displayName } from "@/server/modules/identity/display-name";
import { SessionActions } from "./session-actions";

export const metadata: Metadata = { title: "Sessions" };

export default async function TutorSessionsPage() {
  const tutor = await requireTutor();
  const [board, earnings] = await Promise.all([
    sessionBoardForTutor(tutor),
    earningsForTutor(tutor),
  ]);

  const total =
    board.awaitingAnswer.length + board.upcoming.length + board.past.length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Your sessions"
        description="Confirm attendance after each one. Pay is held until a session is delivered."
      />

      <Card>
        <p className="text-sm text-foreground">
          You have earned{" "}
          <Money
            minor={earnings.earnedMinor}
            currency={earnings.currency}
            className="font-semibold"
          />{" "}
          across {earnings.sessionsDelivered}{" "}
          {earnings.sessionsDelivered === 1 ? "session" : "sessions"}.
        </p>
        <p className="mt-1 text-sm text-muted">
          A session is earned once its attendance is settled — never when it is
          booked.
        </p>
      </Card>

      {total === 0 ? (
        <EmptyState
          icon="calendar"
          title="No sessions yet"
          description="That is all of them. A session appears once you accept a request and the student picks a time from your hours."
          action={
            <ButtonLink href="/tutor" variant="secondary">
              Go to your inbox
            </ButtonLink>
          }
        />
      ) : (
        <>

          <Section title="Waiting on your answer" items={board.awaitingAnswer} />
          <Section title="Coming up" items={board.upcoming} />
          <Section title="Past" items={board.past} />
        </>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: SessionListItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-muted">
        {title}
      </h2>
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.sessionId}>
            <SessionCard item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionCard({ item }: { item: SessionListItem }) {
  const context = [
    item.courseCode,
    item.section ? `Section ${item.section}` : null,
    item.professorName ? `Prof. ${item.professorName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {context}
        </p>
        <h3 className="text-base font-semibold tracking-tight">
          {formatDayTime(item.scheduledAt)}
        </h3>
        <p className="text-sm text-muted">
          {item.durationMinutes} min · {displayName(item.otherPartyName, "student")}
          {item.locationNote ? ` · ${item.locationNote}` : ""}
        </p>
      </div>

      {item.action === "confirm_or_deny" ||
      item.action === "cancel" ||
      item.action === "late_cancel" ? (
        <SessionActions
          sessionId={item.sessionId}
          studentName={displayName(item.otherPartyName, "student")}
          action={item.action}
        />
      ) : (
        <p className="text-sm text-muted">{settledCopy(item)}</p>
      )}
    </Card>
  );
}

function settledCopy(item: SessionListItem): string {
  const student = displayName(item.otherPartyName, "student");

  const youSaid =
    item.yourAnswer === "denied"
      ? `You said ${student} did not show up.`
      : "You confirmed this happened.";

  if (item.action === "awaiting_review") {
    const theySaid =
      item.yourAnswer === "denied"
        ? `${student} said it happened.`
        : `${student} said it did not.`;
    return `${youSaid} ${theySaid} Nothing moves until someone reviews it.`;
  }

  if (item.action === "awaiting_other_party") {
    return `${youSaid} Waiting on ${student} to answer.`;
  }

  if (item.status === "scheduled") return "Happening now.";

  if (item.status === "completed") {
    switch (item.resolution) {
      case "auto_released":
        return "Delivered. Nobody answered inside 24 hours, so it released.";
      case "resolved_attended":
        return "Delivered, after review.";
      default:
        return `Delivered. You and ${student} both confirmed it.`;
    }
  }

  return item.resolution === "resolved_not_attended"
    ? `It did not happen. The session went back to ${student}'s package.`
    : `Cancelled. ${student} can book another time.`;
}
