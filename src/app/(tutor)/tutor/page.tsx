import type { Metadata } from "next";

import { MessageLink } from "@/app/messages/message-link";
import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatCountdown, formatDayTime } from "@/components/format";
import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { packageSummary } from "@/server/modules/billing/pricing";
import { requireTutor, type TutorActor } from "@/server/modules/identity/actor";
import { inboxForTutor, type TutorInboxItem } from "@/server/modules/matching/requests";
import { availabilityForTutor } from "@/server/modules/tutoring/availability";
import { coursesForTutor } from "@/server/modules/tutoring/courses";
import { defaultLocationFor } from "@/server/modules/tutoring/location";

import { displayName } from "@/server/modules/identity/display-name";
import { LocationNudge, SET_LOCATION_HREF } from "./location-nudge";
import { RequestActions } from "./request-actions";

export const metadata: Metadata = { title: "Inbox" };

const URGENT_MINUTES = 120;

export default async function TutorInboxPage() {
  const tutor = await requireTutor();
  const [requests, location] = await Promise.all([
    inboxForTutor(tutor),
    defaultLocationFor(tutor),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Requests for you"
        description="Accept or pass. Passing costs you nothing — letting one expire does."
      />

      <p className="text-sm text-muted">
        Students who book you again through Quad Tutor move you up for that course.
      </p>

      {requests.length === 0 ? (
        <NothingWaiting tutor={tutor} location={location} />
      ) : (
        <>
          {location ? null : <LocationNudge />}
          <ul className="flex flex-col gap-4">
            {requests.map((request) => (
              <li key={request.id}>
                <RequestCard request={request} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

async function NothingWaiting({
  tutor,
  location,
}: {
  tutor: TutorActor;
  location: string | null;
}) {
  const [claims, windows] = await Promise.all([
    coursesForTutor(tutor),
    availabilityForTutor(tutor),
  ]);

  if (claims.length === 0) {
    return (
      <EmptyState
        icon="book"
        title="Claim a course first"
        description="Students ask course by course, so nobody can reach you until you have claimed one you took and did well in."
        action={<ButtonLink href="/tutor/courses">Add a course</ButtonLink>}
      />
    );
  }

  if (!claims.some((claim) => claim.status === "active")) {
    return (
      <EmptyState
        icon="book"
        title="Waiting on verification"
        description="A person is checking the grade on your claim against your transcript. You will start getting requests once it clears — nothing else is needed from you."
        action={
          <ButtonLink href="/tutor/courses" variant="secondary">
            Your courses
          </ButtonLink>
        }
      />
    );
  }

  if (windows.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="Add your hours"
        description="Your course is live, but a student books a time out of your weekly hours — and you have none set, so there is nothing to book."
        action={<ButtonLink href="/tutor/availability">Set your hours</ButtonLink>}
      />
    );
  }

  if (!location) {
    return (
      <EmptyState
        icon="pin"
        title="Say where you meet"
        description="Your course and hours are live. Set your usual spot so students know where to go before they book — otherwise they are told it is not decided yet."
        action={<ButtonLink href={SET_LOCATION_HREF}>Set your spot</ButtonLink>}
      />
    );
  }

  return (
    <EmptyState
      icon="inbox"
      title="Nothing waiting on you"
      description="That is all of them. A request arrives when a student in one of your courses picks you, and it holds for 12 hours."
      action={
        <ButtonLink href="/tutor/courses" variant="secondary">
          Courses you tutor
        </ButtonLink>
      }
    />
  );
}

function RequestCard({ request }: { request: TutorInboxItem }) {
  const context = [
    request.courseCode,
    request.section ? `Section ${request.section}` : null,
    request.professorName ? `Prof. ${request.professorName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {context}
        </p>
        <h2 className="text-lg font-semibold tracking-tight">
          {displayName(request.studentName, "student")}
        </h2>
        <p className="text-sm text-muted">{request.courseTitle}</p>
      </div>

      {request.requestedKind ? (
        <p className="flex items-center gap-2 text-sm font-medium">
          <Icon name="calendar" className="size-4 shrink-0 text-muted" />
          Asking for {packageSummary(request.requestedKind)}
        </p>
      ) : null}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span
          className={`inline-flex items-center gap-1.5 font-medium ${
            request.expiresInMinutes <= URGENT_MINUTES
              ? "text-danger"
              : "text-foreground"
          }`}
        >
          <Icon name="clock" className="size-4" />
          Expires {formatCountdown(request.expiresAt)}
        </span>
        <span className="text-muted">· {formatDayTime(request.expiresAt)}</span>
      </p>

      <p className="rounded-xl bg-surface-sunken px-3 py-2 text-sm text-muted">
        You took {request.courseCode} in {request.takenTermName} and earned{" "}
        {request.gradeEarned}.
      </p>

      <MessageLink threadId={request.threadId} className="self-start" />

      <RequestActions
        requestId={request.id}
        studentName={displayName(request.studentName, "student")}
      />
    </Card>
  );
}
