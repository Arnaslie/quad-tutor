import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDay, formatDayTime, formatTime } from "@/components/format";
import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { SessionError } from "@/server/modules/engagements/access";
import { sessionDetail, type SessionDetail } from "@/server/modules/engagements/reads";
import { requireActor } from "@/server/modules/identity/actor";

import { SessionActions } from "./session-actions";
import { displayName } from "@/server/modules/identity/display-name";

export const metadata: Metadata = { title: "Session" };

export default async function SessionPage(props: PageProps<"/sessions/[id]">) {
  const { id } = await props.params;
  const actor = await requireActor();

  let session: SessionDetail;
  try {
    session = await sessionDetail({ actor, sessionId: id });
  } catch (error) {
    if (error instanceof SessionError) notFound();
    throw error;
  }

  if (session.viewerRole !== "student") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="You are the tutor on this one" />
        <Card className="flex flex-col items-start gap-3 text-sm text-muted">
          <p>
            This session is in your tutoring work, not your own. It lives on the
            tutor side of the app.
          </p>
          <ButtonLink href="/tutor/sessions" variant="secondary">
            Go to your tutoring sessions
          </ButtonLink>
        </Card>
      </div>
    );
  }

  const otherParty = displayName(session.otherPartyName, "tutor");

  const eyebrow = [
    session.courseCode,
    session.section ? `Section ${session.section}` : null,
    session.professorName,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={eyebrow || session.courseTitle}
        title={formatDay(session.scheduledAt)}
        description={`${formatTime(session.scheduledAt)} · ${session.durationMinutes} minutes with ${otherParty}`}
        action={
          <ButtonLink href="/sessions" variant="secondary">
            All sessions
          </ButtonLink>
        }
      />

      <Card padded={false}>
        <dl className="divide-y divide-border">
          <Row label="Status" value={statusLine(session)} />
          <Row label="Tutor" value={otherParty} />
          <Row
            label="Where"
            value={session.locationNote ?? "Not set — agree it between you"}
          />
          <Row
            label="This package"
            value={`${session.sessionsRemaining} of ${session.sessionsPurchased} left to book`}
          />
        </dl>
      </Card>

      <SessionActions
        sessionId={session.sessionId}
        action={session.action}
        otherPartyName={otherParty}
        yourAnswer={session.yourAnswer}
        theirAnswer={session.theirAnswer}
      />

      {session.action === "confirm_or_deny" && session.confirmationWindowEndsAt ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Icon name="clock" className="size-4 shrink-0" />
          Answer by {formatDayTime(session.confirmationWindowEndsAt)}.
        </p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3 sm:px-5">
      <dt className="shrink-0 text-sm text-muted">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

function statusLine(session: SessionDetail): string {
  switch (session.status) {
    case "scheduled":
      return "Booked";
    case "cancelled":
      return "Cancelled";
    case "disputed":
      return "Under review";
    case "completed":
      switch (session.resolution) {
        case "both_confirmed":
          return "Both of you confirmed it";
        case "auto_released":
          return "Settled automatically — nobody answered in time";
        case "resolved_attended":
          return "Settled by review: it happened";
        case "resolved_not_attended":
          return "Settled by review: it did not happen";
        default:
          return "Finished";
      }
  }
}
