import type { Metadata } from "next";
import { z } from "zod";

import { ButtonLink } from "@/components/button";
import { Card, CardLink } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatCountdown } from "@/components/format";
import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/page-header";
import { packageOptions } from "@/server/modules/billing/pricing";
import { upcomingExams } from "@/server/modules/catalog/courses";
import { PurchaseError, slotsForRequest } from "@/server/modules/engagements/purchase";
import { requireActor } from "@/server/modules/identity/actor";
import {
  requestsForStudent,
  type StudentRequest,
} from "@/server/modules/matching/requests";

import { PurchasePanel } from "./purchase-panel";
import { displayName } from "@/server/modules/identity/display-name";

export const metadata: Metadata = { title: "Requests" };

const buyParam = z.uuid();

export default async function RequestsPage(props: PageProps<"/requests">) {
  const actor = await requireActor();
  const searchParams = await props.searchParams;

  const requests = await requestsForStudent(actor);

  const raw = searchParams.buy;
  const buying = buyParam.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (buying.success) {
    const request = requests.find((row) => row.id === buying.data);
    if (request && request.status === "accepted" && request.engagementId === null) {
      return <PurchaseStep actorRequest={request} />;
    }
  }

  const pending = requests.filter((request) => request.status === "pending");
  const accepted = requests.filter((request) => request.status === "accepted");
  const closed = requests.filter(
    (request) => request.status !== "pending" && request.status !== "accepted",
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Your asks"
        description="Up to three tutors at once. The first to say yes is the one you get; the rest drop off on their own."
      />

      {requests.length === 0 ? (
        <EmptyState
          icon="send"
          title="You have not asked anyone yet"
          description="Pick the course you are stuck in and ask up to three tutors in one go. Nothing is charged unless someone says yes."
          action={<ButtonLink href="/courses">Find a tutor</ButtonLink>}
        />
      ) : null}

      {accepted.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Accepted">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Said yes
          </h2>
          {accepted.map((request) => (
            <Accepted key={request.id} request={request} />
          ))}
        </section>
      ) : null}

      {pending.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Waiting">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Waiting to hear back
          </h2>
          {pending.map((request) => (
            <Card key={request.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{displayName(request.tutorName, "tutor")}</p>
                <p className="truncate text-sm text-muted">{context(request)}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1.5 text-sm text-muted">
                <Icon name="clock" className="size-4" />
                {formatCountdown(request.expiresAt)}
              </span>
            </Card>
          ))}
          <p className="text-sm text-muted">
            Asks run out after 12 hours. When one does, you get the slot back to
            ask somebody else.
          </p>
        </section>
      ) : null}

      {closed.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Earlier">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Earlier
          </h2>
          {closed.map((request) => (
            <Card key={request.id} className="flex flex-col gap-0.5">
              <p className="font-medium">{displayName(request.tutorName, "tutor")}</p>
              <p className="text-sm text-muted">{context(request)}</p>
              <p className="pt-1 text-sm text-muted">{outcome(request.status)}</p>
            </Card>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function context(request: StudentRequest): string {
  return [
    request.courseCode,
    request.section ? `Section ${request.section}` : null,
    request.professorName,
  ]
    .filter(Boolean)
    .join(" · ");
}

function outcome(status: StudentRequest["status"]): string {
  switch (status) {
    case "declined":
      return "Passed — they are full this stretch. Tutors say no for free here, so it is about their week, not about you.";
    case "expired":
      return "Ran out of time without an answer.";
    case "withdrawn":
      return "Dropped off automatically — another tutor said yes first.";
    default:
      return "";
  }
}

function Accepted({ request }: { request: StudentRequest }) {
  if (request.engagementId) {
    return (
      <CardLink href="/sessions" className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">{displayName(request.tutorName, "tutor")}</p>
          <p className="truncate text-sm text-muted">{context(request)}</p>
          <p className="pt-1 text-sm text-muted">
            Package bought. Your sessions are on the session board.
          </p>
        </div>
        <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
      </CardLink>
    );
  }

  return (
    <Card className="flex flex-col items-start gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{displayName(request.tutorName, "tutor")} said yes</p>
        <p className="text-sm text-muted">{context(request)}</p>
      </div>
      <ButtonLink href={`/requests?buy=${request.id}`}>
        Pick a package and a time
      </ButtonLink>
    </Card>
  );
}

async function PurchaseStep({ actorRequest }: { actorRequest: StudentRequest }) {
  const actor = await requireActor();

  let slots: Date[];
  try {
    slots = await slotsForRequest({ actor, requestId: actorRequest.id });
  } catch (error) {
    if (error instanceof PurchaseError) {
      return (
        <div className="flex flex-col gap-6">
          <PageHeader title="That ask has moved on" />
          <EmptyState
            icon="send"
            title={error.message}
            description="Nothing was charged."
            action={<ButtonLink href="/requests">Back to your asks</ButtonLink>}
          />
        </div>
      );
    }
    throw error;
  }

  const exams = await upcomingExams(actorRequest.offeringId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={context(actorRequest)}
        title={`${displayName(actorRequest.tutorName, "tutor")} said yes`}
        description="Pick how many sessions and when the first one is. This is the first time anything is charged."
        action={
          <ButtonLink href="/requests" variant="secondary">
            Back
          </ButtonLink>
        }
      />

      <PurchasePanel
        requestId={actorRequest.id}
        tutorName={displayName(actorRequest.tutorName, "tutor")}
        slots={slots.map((slot) => slot.toISOString())}
        exams={exams}
        options={packageOptions()}
      />
    </div>
  );
}
