"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { Icon } from "@/components/icons";

import { askTutors, type ActionResult } from "../../actions";

/**
 * What a tutor card is allowed to know about a tutor.
 *
 * Deliberately narrower than `DeckCard`: the ranking score, the sample count
 * and the posterior mean are stripped on the server before anything crosses
 * into this file. They are not rendered either way, but a hidden score sitting
 * in the RSC payload is one "view source" away from being a public rating, and
 * the rule is that quality is expressed *only* as rank order.
 *
 * `matchesProfessor` is not a score — it is the wedge stated as a fact about
 * the pair, and it is the single most useful thing on the card.
 */
export type TutorCard = {
  tutorCourseId: string;
  tutorName: string;
  headline: string | null;
  bio: string | null;
  gradeEarned: string;
  takenUnderProfessorName: string | null;
  takenTermName: string;
  matchesProfessor: boolean;
};

/* -------------------------------------------------------------------------- */
/* the card body, shared by both treatments                                   */
/* -------------------------------------------------------------------------- */

function TutorProfile({ tutor }: { tutor: TutorCard }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-lg font-semibold tracking-tight">{tutor.tutorName}</h3>
        {tutor.headline ? (
          <p className="text-sm text-muted">{tutor.headline}</p>
        ) : null}
      </div>

      <dl className="flex flex-col gap-1.5 text-sm">
        <div className="flex gap-2">
          <dt className="sr-only">Took it under</dt>
          <dd
            className={`flex items-start gap-2 ${
              tutor.matchesProfessor ? "text-accent" : "text-foreground"
            }`}
          >
            <Icon name="cap" className="mt-0.5 size-4 shrink-0" />
            <span>
              {tutor.takenUnderProfessorName
                ? `Took it under ${tutor.takenUnderProfessorName}`
                : "Took it — instructor not recorded"}
              {tutor.matchesProfessor ? " — your professor" : ""}
            </span>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="sr-only">When, and the grade</dt>
          <dd className="flex items-start gap-2 text-foreground">
            <Icon name="clock" className="mt-0.5 size-4 shrink-0 text-muted" />
            <span>
              {tutor.takenTermName} · earned {tutor.gradeEarned}
            </span>
          </dd>
        </div>
      </dl>

      {tutor.bio ? (
        <p className="text-sm leading-relaxed text-muted">{tutor.bio}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* selection, shared                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Asking is a cheap, parallel, non-exclusive signal — not a choice between
 * people. So selection is a set, the submit is one batch, and nothing in the
 * copy frames an ask as a commitment to anybody.
 */
function useSelection(room: number) {
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((current) => {
      if (current.includes(id)) return current.filter((value) => value !== id);
      if (current.length >= room) return current;
      return [...current, id];
    });
  }

  return { selected, toggle, full: selected.length >= room };
}

function Submit({
  offeringId,
  selected,
  state,
  pending,
}: {
  offeringId: string;
  selected: string[];
  state: ActionResult | null;
  pending: boolean;
}) {
  return (
    <>
      <input type="hidden" name="offeringId" value={offeringId} />
      {selected.map((id) => (
        <input key={id} type="hidden" name="tutorCourseId" value={id} />
      ))}

      {state && !state.ok ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={pending || selected.length === 0}>
        {pending
          ? "Sending…"
          : selected.length === 0
            ? "Pick a tutor"
            : selected.length === 1
              ? "Ask 1 tutor"
              : `Ask ${selected.length} tutors`}
      </Button>
      <p className="text-center text-xs text-muted">
        They have 12 hours to answer. The first to say yes is the one you get —
        the rest drop off on their own. Nothing is charged until then.
      </p>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* 1–2 tutors — a reveal, explicitly not a deck                               */
/* -------------------------------------------------------------------------- */

/**
 * A two-card stack advertises your own thinness. So one or two tutors are
 * shown whole, in full, with no counter and no paging — this reads as "here is
 * who covers this", which is the truth.
 */
export function SingleReveal({
  offeringId,
  tutors,
  room,
}: {
  offeringId: string;
  tutors: TutorCard[];
  room: number;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    askTutors,
    null,
  );
  const { selected, toggle, full } = useSelection(room);

  return (
    <form action={action} className="flex flex-col gap-4">
      {tutors.map((tutor) => {
        const isSelected = selected.includes(tutor.tutorCourseId);
        return (
          <Card key={tutor.tutorCourseId} className="flex flex-col gap-4">
            <TutorProfile tutor={tutor} />
            <Button
              type="button"
              variant={isSelected ? "primary" : "secondary"}
              onClick={() => toggle(tutor.tutorCourseId)}
              disabled={!isSelected && full}
              aria-pressed={isSelected}
            >
              {isSelected ? "Selected" : "Ask this tutor"}
            </Button>
          </Card>
        );
      })}

      <Submit
        offeringId={offeringId}
        selected={selected}
        state={state}
        pending={pending}
      />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* 3+ tutors — the deck                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One card at a time with the count stated out loud. "1 of 6" is the whole
 * point: it turns a short list into a complete one. "That is all of them"
 * reads honest where "that is all we found" reads broken, and the counter is
 * what makes the first reading available.
 *
 * Ranking is the only place quality is expressed. Card one is the best match
 * and nothing on screen says so in words.
 */
export function TutorDeck({
  offeringId,
  tutors,
  room,
}: {
  offeringId: string;
  tutors: TutorCard[];
  room: number;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    askTutors,
    null,
  );
  const { selected, toggle, full } = useSelection(room);
  const [index, setIndex] = useState(0);

  const tutor = tutors[index];
  const isSelected = selected.includes(tutor.tutorCourseId);
  const atEnd = index >= tutors.length - 1;

  function advance() {
    setIndex((current) => Math.min(current + 1, tutors.length - 1));
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted" aria-live="polite">
          {index + 1} of {tutors.length}
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setIndex((current) => Math.max(current - 1, 0))}
            disabled={index === 0}
            aria-label="Previous tutor"
          >
            Back
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={advance}
            disabled={atEnd}
            aria-label="Next tutor"
          >
            Next
          </Button>
        </div>
      </div>

      <Card className="flex flex-col gap-4">
        <TutorProfile tutor={tutor} />
        <div className="flex gap-2">
          <Button
            type="button"
            variant={isSelected ? "primary" : "secondary"}
            className="flex-1"
            onClick={() => {
              toggle(tutor.tutorCourseId);
              if (!isSelected && !atEnd) advance();
            }}
            disabled={!isSelected && full}
            aria-pressed={isSelected}
          >
            {isSelected ? "Selected" : "Ask"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="flex-1"
            onClick={advance}
            disabled={atEnd}
          >
            Skip
          </Button>
        </div>
      </Card>

      {atEnd ? (
        <p className="text-center text-sm text-muted">
          That is all {tutors.length} of them.
        </p>
      ) : null}

      <Submit
        offeringId={offeringId}
        selected={selected}
        state={state}
        pending={pending}
      />
    </form>
  );
}
