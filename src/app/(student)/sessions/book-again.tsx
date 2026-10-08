import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDay } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { packageSummary } from "@/server/modules/billing/pricing";
import { slotsForTopUp } from "@/server/modules/engagements/purchase";
import { bookAgain, bookAgainPath, type BookAgain } from "@/server/modules/engagements/reads";
import { requireActor } from "@/server/modules/identity/actor";
import { displayName } from "@/server/modules/identity/display-name";

import { BookAgainForm } from "./book-again-form";

type LiveRequest = NonNullable<BookAgain["liveRequest"]>;

function liveLine(request: LiveRequest, tutor: string): string {
  const summary = request.requestedKind
    ? packageSummary(request.requestedKind).toLowerCase()
    : null;
  return request.status === "pending"
    ? `You asked ${tutor}${summary ? ` for ${summary}` : ""}. Their answer comes back within 12 hours.`
    : `${tutor} said yes${summary ? ` to ${summary}` : ""}. Pick a time to check out.`;
}

function LiveAction({ request }: { request: LiveRequest }) {
  return request.status === "pending" ? (
    <ButtonLink href="/requests" variant="secondary">
      See your asks
    </ButtonLink>
  ) : (
    <ButtonLink href={`/requests?buy=${request.id}`}>Pick a time</ButtonLink>
  );
}

export function BookAgainCard({ pair }: { pair: BookAgain }) {
  const tutor = displayName(pair.tutorName, "tutor");
  const course = pair.courseCode ?? pair.courseTitle;

  return (
    <Card className="flex flex-col items-start gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">
          {course} · {tutor}
        </p>
        <p className="text-sm text-muted">
          {pair.liveRequest
            ? liveLine(pair.liveRequest, tutor)
            : `Nothing left to book with ${tutor}, and the term ends ${formatDay(pair.termEndsOn)}. Book a package or one more session — same tutor, no deck.`}
        </p>
      </div>

      {pair.liveRequest ? (
        <LiveAction request={pair.liveRequest} />
      ) : (
        <ButtonLink href={bookAgainPath(pair.tutorCourseId)} variant="secondary">
          Book again
        </ButtonLink>
      )}
    </Card>
  );
}

export async function BookAgainStep({ tutorCourseId }: { tutorCourseId: string }) {
  const actor = await requireActor();
  const pair = await bookAgain(actor, tutorCourseId);

  if (!pair) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Nothing to book here" />
        <EmptyState
          icon="calendar"
          title="You can book again once nothing is left to book with this tutor, before the term ends."
          description="Nothing was charged."
          action={<ButtonLink href="/sessions">Back to your sessions</ButtonLink>}
        />
      </div>
    );
  }

  const tutor = displayName(pair.tutorName, "tutor");
  const slots = pair.liveRequest ? [] : await slotsForTopUp({ actor, tutorCourseId });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={pair.courseCode ?? pair.courseTitle}
        title={`Book again with ${tutor}`}
        description={`Same tutor, no deck. The term ends ${formatDay(pair.termEndsOn)}.`}
        action={
          <ButtonLink href="/sessions" variant="secondary">
            Back
          </ButtonLink>
        }
      />

      {pair.liveRequest ? (
        <Card className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">{liveLine(pair.liveRequest, tutor)}</p>
          <LiveAction request={pair.liveRequest} />
        </Card>
      ) : (
        <BookAgainForm
          tutorCourseId={pair.tutorCourseId}
          tutorName={tutor}
          location={pair.tutorLocation}
          currency={pair.currency}
          slots={slots.map((slot) => slot.toISOString())}
        />
      )}
    </div>
  );
}
