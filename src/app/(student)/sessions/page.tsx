import type { Metadata } from "next";
import type { ReactNode } from "react";
import { z } from "zod";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDay } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { SessionError } from "@/server/modules/engagements/access";
import {
  packagesForStudent,
  sessionBoardForStudent,
  type StudentPackage,
} from "@/server/modules/engagements/reads";
import { slotsForEngagement } from "@/server/modules/engagements/scheduling";
import { requireActor } from "@/server/modules/identity/actor";

import { BookNext } from "./book-next";
import { SessionRow } from "./session-row";
import { displayName } from "@/server/modules/identity/display-name";

export const metadata: Metadata = { title: "Sessions" };

const bookParam = z.uuid();

/**
 * The session board. One query, three buckets, in the order they matter.
 *
 * `awaitingAnswer` leads and is not filed under "past" — a finished session
 * nobody has answered for is the most actionable thing on this screen, and
 * burying it is how a confirmation window lapses. Prevention comes before
 * penalty, and a visible prompt is the cheapest prevention there is.
 *
 * Packages sit above the sessions because a package with sessions left and
 * nothing on the calendar is the one state a student can get stuck in — it is
 * where a cancellation leaves them.
 */
export default async function SessionsPage(props: PageProps<"/sessions">) {
  const actor = await requireActor();
  const searchParams = await props.searchParams;

  const rawBook = searchParams.book;
  const booking = bookParam.safeParse(Array.isArray(rawBook) ? rawBook[0] : rawBook);
  if (booking.success) {
    return <BookingStep engagementId={booking.data} />;
  }

  const justPurchased = Boolean(searchParams.package);

  const [board, packages] = await Promise.all([
    sessionBoardForStudent(actor),
    packagesForStudent(actor),
  ]);

  const empty =
    board.awaitingAnswer.length === 0 &&
    board.upcoming.length === 0 &&
    board.past.length === 0 &&
    packages.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sessions"
        description="Everything booked, and everything still to settle."
      />

      {justPurchased ? (
        <Card className="bg-accent-soft text-sm text-accent">
          Your package is paid for and your first session is booked. Book the rest
          whenever you like — anything you do not use refunds at the end of term.
        </Card>
      ) : null}

      {empty ? (
        <EmptyState
          icon="calendar"
          title="Nothing booked yet"
          description="Sessions show up here once a tutor accepts and you pick a time. This is what day one looks like for everybody."
          action={<ButtonLink href="/courses">Find a tutor</ButtonLink>}
        />
      ) : null}

      <Section
        title="Did these happen?"
        description="Both of you answer. If neither of you does within a day, it settles as attended and your tutor gets paid."
        items={board.awaitingAnswer}
      />

      <Section title="Coming up" items={board.upcoming} />

      {packages.length > 0 ? (
        <section className="flex flex-col gap-2" aria-label="Your packages">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Your packages
          </h2>
          {packages.map((pkg) => (
            <PackageCard key={pkg.engagementId} pkg={pkg} />
          ))}
        </section>
      ) : null}

      <Section
        title="Done"
        description={
          board.past.length > 0 ? "Settled, cancelled, or waiting on review." : undefined
        }
        items={board.past}
      />
    </div>
  );
}

function Section({
  title,
  description,
  items,
}: {
  title: string;
  description?: ReactNode;
  items: Parameters<typeof SessionRow>[0]["session"][];
}) {
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        {title}
      </h2>
      {description ? <p className="text-sm text-muted">{description}</p> : null}
      {items.map((session) => (
        <SessionRow key={session.sessionId} session={session} />
      ))}
    </section>
  );
}

/**
 * Sessions left, and the way to put one on the calendar. Unused sessions
 * refund at the end of term, so this never nags — it just makes the next step
 * one tap away.
 */
function PackageCard({ pkg }: { pkg: StudentPackage }) {
  const tutor = displayName(pkg.tutorName, "tutor");
  const course = [pkg.courseCode ?? pkg.courseTitle, pkg.professorName]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="flex flex-col items-start gap-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">
          {course} · {tutor}
        </p>
        <p className="text-sm text-muted">
          {pkg.sessionsRemaining} of {pkg.sessionsPurchased} left to book
          {pkg.anchorExamName && pkg.anchorExamOccursOn
            ? ` · ${pkg.anchorExamName} is ${formatDay(pkg.anchorExamOccursOn)}`
            : ""}
        </p>
      </div>

      {pkg.sessionsRemaining > 0 ? (
        <ButtonLink href={`/sessions?book=${pkg.engagementId}`} variant="secondary">
          Book the next one
        </ButtonLink>
      ) : (
        <p className="text-sm text-muted">
          Every session is on the calendar. Anything you do not use refunds at the
          end of term.
        </p>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* booking session 2..N                                                       */
/* -------------------------------------------------------------------------- */

async function BookingStep({ engagementId }: { engagementId: string }) {
  const actor = await requireActor();

  const packages = await packagesForStudent(actor);
  const pkg = packages.find((row) => row.engagementId === engagementId);

  let slots: Date[] = [];
  let problem: string | null = null;

  try {
    slots = await slotsForEngagement({ actor, engagementId });
  } catch (error) {
    if (error instanceof SessionError) problem = error.message;
    else throw error;
  }

  if (!pkg || problem) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Nothing to book here" />
        <EmptyState
          icon="calendar"
          title={problem ?? "That package is not yours, or it is closed."}
          description="Nothing was charged."
          action={<ButtonLink href="/sessions">Back to your sessions</ButtonLink>}
        />
      </div>
    );
  }

  const tutor = displayName(pkg.tutorName, "tutor");
  const course = [pkg.courseCode ?? pkg.courseTitle, pkg.professorName]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={course}
        title="Book your next session"
        description={`${pkg.sessionsRemaining} of ${pkg.sessionsPurchased} left. Already paid for — nothing is charged again.`}
        action={
          <ButtonLink href="/sessions" variant="secondary">
            Back
          </ButtonLink>
        }
      />

      {slots.length === 0 ? (
        <EmptyState
          icon="clock"
          title={`${tutor} has no times open right now`}
          description="Their hours change week to week, and your sessions do not expire before the end of term. Check back in a day or two."
          action={<ButtonLink href="/sessions">Back to your sessions</ButtonLink>}
        />
      ) : (
        <BookNext
          engagementId={pkg.engagementId}
          tutorName={tutor}
          slots={slots.map((slot) => slot.toISOString())}
        />
      )}
    </div>
  );
}
