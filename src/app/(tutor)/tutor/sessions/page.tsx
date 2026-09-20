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

/**
 * The other side of the board. Same three buckets as the student's, from the
 * same query with a different viewer, so the two cannot disagree about what a
 * session is.
 *
 * The one money line is the ledger's own total and nothing else. Tutor pay is
 * recognised when a session is delivered, so a booked-but-undelivered session
 * contributes nothing — showing what is booked would be a forecast wearing the
 * same font as a fact. Zero is a true answer to "when do I get paid", as long
 * as it says what it is counting.
 */
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
          {/* Finished and unanswered comes first: a lapsed confirmation window
              is prevented by putting the prompt where it cannot be missed. */}
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

/**
 * Everything that is not a button. `auto_released` is named honestly rather
 * than dressed up as a confirmation: nobody answered, and the money defaulted
 * because a wrong default is refundable where a wrong fact is not.
 */
function settledCopy(item: SessionListItem): string {
  const student = displayName(item.otherPartyName, "student");

  // What *you* said, not just that you said something. A tutor who cannot see
  // which button they pressed has no way to catch their own mistake, and the
  // two answers mean very different things to the person on the other side.
  const youSaid =
    item.yourAnswer === "denied"
      ? `You said ${student} did not show up.`
      : "You confirmed this happened.";

  if (item.action === "awaiting_review") {
    // DEPENDENCY, not a second implementation of the rule: this relies on
    // `settle()` producing `disputed` from exactly one confirm and one deny,
    // which is its invariant and nothing this file gets to decide. Given that,
    // their answer is the opposite of yours and needs no extra field.
    //
    // If a third path to `disputed` is ever added — a resolved case reopened,
    // say — this silently starts telling a tutor the wrong thing about what
    // they were accused of, and nothing fails loudly. The fix then is to ask
    // `backend-dev` for `theirAnswer` on `SessionListItem` (it exists on
    // `sessionDetail` already) and delete the inference rather than patch it.
    //
    // Naming both answers is the point: "they answered differently" leaves a
    // tutor guessing what they are accused of.
    //
    // The denial note stays out of this deliberately, on both surfaces. It is
    // one side's written account for whoever settles the dispute, and putting
    // it in front of the other party turns a disagreement into a fight.
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

  // Cancelled: either called off in advance, or agreed it never happened.
  return item.resolution === "resolved_not_attended"
    ? `It did not happen. The session went back to ${student}'s package.`
    : `Cancelled. ${student} can book another time.`;
}
