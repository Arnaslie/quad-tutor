import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { formatDay } from "@/components/format";
import { PageHeader } from "@/components/page-header";
import { offeringById, upcomingExams } from "@/server/modules/catalog/courses";
import { requireActor } from "@/server/modules/identity/actor";
import { buildDeck } from "@/server/modules/matching/candidates";
import { requestsForStudent, standingFor } from "@/server/modules/matching/requests";
import { MAX_PARALLEL_ASKS } from "@/server/modules/reliability/standing";

import { DemandCapture } from "./demand-capture";
import { SingleReveal, TutorDeck, type TutorCard } from "./tutor-picker";
import { displayName } from "@/server/modules/identity/display-name";

export const metadata: Metadata = { title: "Tutors" };

/**
 * The wedge, made visible.
 *
 * Presentation is a function of supply count and the rule is hard: 0 is demand
 * capture, 1–2 is a single reveal, 3+ is a deck with the count stated out
 * loud. `presentationFor` in `matching/candidates.ts` decides; this file only
 * renders what it decided.
 *
 * There are no scores, stars or badges anywhere below, and the ranking score
 * is dropped before anything reaches a client component. Quality is rank order
 * and nothing else.
 */
export default async function TutorDeckPage(props: PageProps<"/courses/[offeringId]">) {
  const { offeringId } = await props.params;
  const actor = await requireActor();

  const offering = await offeringById({
    offeringId,
    institutionId: actor.institutionId,
  });
  if (!offering) notFound();

  const [deck, standing, requests, exams] = await Promise.all([
    // `viewerUserId` hides the student's own tutor profile. A course whose
    // only tutor is the viewer is therefore a zero-tutor deck for them, and
    // falls through to demand capture — which is the honest answer.
    buildDeck({
      courseOfferingId: offeringId,
      institutionId: actor.institutionId,
      viewerUserId: actor.userId,
    }),
    standingFor(actor),
    requestsForStudent(actor),
    upcomingExams(offeringId),
  ]);

  // The cap counts every ask a student has out, not the ones for this course,
  // because that is what `requestTutors` enforces inside its transaction.
  const pending = requests.filter((request) => request.status === "pending");
  const room = Math.max(0, standing.parallelAskLimit - pending.length);

  // Everything the score is made of stays on the server. See the note on
  // `TutorCard`.
  const tutors: TutorCard[] = deck.candidates.map((candidate) => ({
    tutorCourseId: candidate.tutorCourseId,
    tutorName: displayName(candidate.tutorName, "tutor"),
    headline: candidate.headline,
    bio: candidate.bio,
    gradeEarned: candidate.gradeEarned,
    takenUnderProfessorName: candidate.takenUnderProfessorName,
    takenTermName: candidate.takenTermName,
    matchesProfessor: candidate.matchesProfessor,
  }));

  const nextExam = exams.at(0);
  const eyebrow = [
    offering.code,
    offering.section ? `Section ${offering.section}` : null,
    offering.professorName,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={eyebrow}
        title={
          deck.presentation === "demand_capture"
            ? offering.title
            : deck.presentation === "deck"
              ? `${tutors.length} tutors took this course`
              : tutors.length === 1
                ? "One student tutors this course"
                : "Two students tutor this course"
        }
        description={
          deck.presentation === "demand_capture"
            ? undefined
            : "Ranked, no filters — the course code already did the filtering."
        }
        action={
          <ButtonLink href="/courses" variant="secondary">
            Change section
          </ButtonLink>
        }
      />

      {nextExam ? (
        <Card className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-muted">Next exam</span>
          <span className="font-medium">
            {nextExam.name} · {formatDay(nextExam.occursOn)}
          </span>
        </Card>
      ) : null}

      {deck.presentation === "demand_capture" ? (
        <DemandCapture
          offeringId={offeringId}
          courseCode={offering.code}
          courseTitle={offering.title}
          professorName={offering.professorName}
        />
      ) : room === 0 ? (
        <NoRoomLeft pending={pending.length} limit={standing.parallelAskLimit} />
      ) : (
        <>
          {standing.parallelAskLimit < MAX_PARALLEL_ASKS ? (
            <StandingNote
              limit={standing.parallelAskLimit}
              cleanSessionsToRecover={standing.cleanSessionsToRecover}
            />
          ) : null}

          {deck.presentation === "deck" ? (
            <TutorDeck offeringId={offeringId} tutors={tutors} room={room} />
          ) : (
            <SingleReveal offeringId={offeringId} tutors={tutors} room={room} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Standing is expressed as a mechanic and never as a score, a badge or a
 * number attached to the student. The copy has to say what clears it, in the
 * same breath, because every consequence in this system is recoverable by
 * design and one that does not look recoverable is just a punishment.
 */
function StandingNote({
  limit,
  cleanSessionsToRecover,
}: {
  limit: number;
  cleanSessionsToRecover: number;
}) {
  return (
    <Card className="flex flex-col gap-1 bg-surface-sunken text-sm">
      <p className="font-medium">
        You can ask {limit === 1 ? "one tutor" : `${limit} tutors`} at a time right
        now.
      </p>
      <p className="text-muted">
        {cleanSessionsToRecover > 0
          ? `After ${cleanSessionsToRecover} more ${
              cleanSessionsToRecover === 1 ? "session you attend" : "sessions you attend"
            }, it goes back to ${MAX_PARALLEL_ASKS}.`
          : `It goes back to ${MAX_PARALLEL_ASKS} once you have attended your next sessions.`}
      </p>
    </Card>
  );
}

function NoRoomLeft({ pending, limit }: { pending: number; limit: number }) {
  return (
    <Card className="flex flex-col items-start gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">
          You have {pending === 1 ? "an ask" : `${pending} asks`} out already
        </h2>
        <p className="text-sm text-muted">
          {limit === MAX_PARALLEL_ASKS
            ? "Three at a time is the limit, and you are at it."
            : `You can have ${limit} out at a time right now.`}{" "}
          They expire after 12 hours, and the slot frees up the moment one comes
          back.
        </p>
      </div>
      <ButtonLink href="/requests" variant="secondary">
        See your asks
      </ButtonLink>
    </Card>
  );
}
