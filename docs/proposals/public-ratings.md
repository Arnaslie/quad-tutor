# Brief: public ratings and the renewal signal

Status: **build brief, not started.** The rules are settled in `docs/decisions.md`
(Ratings, Renewals). This file is how to build them. Written 2026-10-05 against
`origin/docs/take-rate-cap` at `36ffa09`. Code refs are the same on `origin/main` at
`11fa99e`.

## What exists today

- **Ranker input with no writer.** `tutor_course.score_sample_count` and
  `score_posterior_mean` (`src/server/db/schema.ts:323-324`) are read in
  `src/server/modules/matching/candidates.ts:74-75,106-107`. Nothing writes them.
- **`score.ts:55`** only adds the posterior when `scoreSampleCount > 0`. Once a job
  writes the prior for unrated tutors, that guard would put every unrated tutor below
  every rated one, by nearly the term's full weight, so it has to go.
- **Recognition.** `recognise()` (`engagements/confirmation.ts:21-54`) writes
  `session_earned` for every delivered session. It is called from `applySettlement`
  (`:79-82`) and from dispute resolution (`resolveDispute`, `:253`). That ledger row is
  the definition of a paid session and the start of the rating window. `session_booking`
  has no settled-at column, and does not need one.
- **The card is already a narrow shape.** `TutorCard`
  (`src/app/(student)/courses/[offeringId]/tutor-picker.tsx:11-20`) is mapped from the
  scored `DeckCard` at `page.tsx:44-53`. That mapping is where the score stops today.
- **Reports.** `message_report` (`schema.ts:633-658`) requires `thread_id`, and its
  outcomes are `no_action | warned | escalated`
  (`src/server/modules/messaging/rules.ts:21`). The queue is `/ops/reports`
  (`src/app/ops/reports/`), and the logic is in `messaging/reports.ts`.
- **Cron.** The per-campus loop is `src/app/api/cron/route.ts:45-53`.
- **Renewal data already exists.** `engagement` has `student_profile_id`,
  `tutor_course_id`, `status` and `completed_at` (`schema.ts:401-434`), indexed on
  `tutor_course_id`. A trial and a success are both derivable from it with no new
  writes.

## How stars and renewals share the ranker

`score.ts` has one slot, `posteriorWeight` at 30. It becomes two hidden terms, each
centred on its own course prior:

```
score += (ratingPosteriorBp  / 10_000) * ratingWeight     // 15
score += (renewalPosteriorBp / 10_000) * renewalWeight    // 15
```

- `RankingWeights.posteriorWeight` splits into `ratingWeight` and `renewalWeight`.
- `Candidate` gains `renewalPosteriorMeanBp`.
- Neither term is gated on its sample count, because the job writes the prior at
  `n = 0`.
- They are not blended: different scales, different priors, and each weight can be
  tuned on its own. The 15/15 split is settled (`decisions.md`, Renewals).

## Build

### Schema (Database engineer)

`session_rating`:

| Column | |
|---|---|
| `id` | uuid pk |
| `institution_id` | **not null**, fk `institution` |
| `session_id` | not null, fk `session_booking`, **unique** (one rating per session) |
| `tutor_course_id` | not null, fk `tutor_course`. Denormalised from the engagement, which never changes it, so the aggregate does not join through it. |
| `student_profile_id` | not null, fk `student_profile` |
| `stars` | smallint not null, `check (stars between 1 and 5)` |
| `note` | text null, `check (char_length(note) <= 280)` |
| `created_at`, `updated_at` | timestamptz |
| `removed_at`, `removed_by_user_id` | moderation. A removed rating is out of every aggregate. |

Indexes: `(institution_id, tutor_course_id) where removed_at is null`, and
`(student_profile_id)`.

On `tutor_course`, add `renewal_trial_count` (integer, not null, default 0) and
`renewal_posterior_mean` (integer, basis points). The existing
`score_sample_count` / `score_posterior_mean` carry the star term.

`message_report` becomes the report table for both threads and ratings:

- `thread_id` becomes nullable.
- Add a nullable `session_rating_id`.
- Add `check (num_nonnulls(thread_id, session_rating_id) = 1)`.
- Add `removed` to `report_outcome`.

`message_thread_access` is unaffected: it still requires a thread report.

Review the plans for the aggregate and for the card read. Neither may read across
`institution_id`.

### Server: `src/server/modules/ratings/` (Backend engineer)

- **`rules.ts`** imports nothing. It holds `STARS = [1..5]`, `NOTE_MAX = 280`,
  `WINDOW_DAYS = 14`, `MIN_SESSIONS = 10`, `MIN_RATINGS = 5`, and
  `publicRating(sum, count, sessions)`, which returns `{ average: "4.7", count }` when
  `sessions >= MIN_SESSIONS && count >= MIN_RATINGS`, and `null` otherwise. The same
  gate applies to both ratings: for the overall rating, `count` is all of the tutor's
  ratings; for a course rating, it is that course's ratings, with the tutor's total
  sessions. The client form imports these, so this file must stay import-free (see the
  CLAUDE.md conventions).
- **`src/server/modules/scoring/posterior.ts`** is pure and unit-tested. It holds two
  functions, both returning basis points:
  - stars: `(m·C + Σ stars) / (m + n)` with `m = 5`;
  - renewals: `(successes + 5·C) / (trials + 5)`.

  It also holds the shared prior fallback: the course mean at 20 or more samples, else
  the campus mean at 20 or more, else a constant (4.0★ for stars, 0.4 for renewals).
  It lives outside `matching/` so `score.ts` stays the ranker alone.
- **`capture.ts`** has `rateSession({ actor, sessionId, stars, note })`, with Zod at
  the boundary. It checks four things:
  - the actor is the engagement's student;
  - the session is `completed`;
  - a `session_earned` row exists, and its `occurred_at` is within `WINDOW_DAYS`;
  - the rating has not been removed.

  It upserts on `session_id`, so an edit inside the window is the same call. It writes
  nothing else: no `reliability_event`, and no ledger row.
- **`src/server/modules/scoring/stats.ts`** has `refreshScores(institutionId)`. It
  is one `UPDATE tutor_course … FROM (ratings aggregate) JOIN (renewal aggregate)`,
  scoped by `institution_id`, and it writes all four fields on every active claim,
  including `n = 0`, which gets the prior. It is a full recompute, so it is
  idempotent. The renewal aggregate works as follows:
  - a trial is a distinct `(student_profile_id, tutor_course_id)` whose earliest
    engagement is `completed` or `refunded`;
  - a success is that pair having any later engagement;
  - a guarantee-refunded first engagement is a trial with no success unless the pair
    bought again.
- **`reads.ts`**:
  - `cardRatings(institutionId, tutorCourseIds)` returns, per card, the course
    `publicRating` and the overall one. Sessions are the count of the tutor's
    `session_earned` rows across all courses, and both ratings use that count. The
    threshold is applied *here*: below it the function returns `null`, never the
    numbers.
  - `notesForTutor(actor)` returns note text and course only, for ratings whose window
    has closed, with no student or date.
- **`matching/score.ts`**:
  - split the weight as above;
  - drop the `scoreSampleCount > 0` guard at `:55` and keep the `null` checks;
  - `candidates.ts:74-75,106-107` reads the new column.

  `score.ts` stays pure.
- **`messaging/reports.ts`**:
  - add `reportRating`, which only the rated tutor can call;
  - teach `reportsForOperator` and `reviewReport` the rating case;
  - a `removed` outcome sets `session_rating.removed_at`.

### Sweep (Distributed-systems engineer)

- Call `refreshScores(campus.id)` in the cron loop (`route.ts:45`), wrapped in
  `.catch` like the proof purge, so a failure here never blocks refunds.
- A rating written between runs reaches the ranker on the next run. The card reads
  live, so the student sees it at once. That lag is fine.
- The window needs no sweep: closing is computed from `session_earned.occurred_at` at
  read time.
- Confirm that overlapping cron runs only race to write the same values.

### Pages (Web engineer)

- **Capture.** Add a star control and an optional note to
  `src/app/(student)/sessions/[id]/page.tsx` when the session is `completed` and inside
  the window. It prefills when editing and reads "Rating closed" afterwards. There is
  one prompt, on this page only, and no email.
- **Card.**
  - `TutorCard` gains exactly `courseRating` and `overallRating`, each
    `{ average: string; count: number } | null`. They are filled at `page.tsx:44`
    from `cardRatings`.
  - The card shows "4.7 · 12 ratings", or "New in this course" / "New tutor" when the
    value is `null`.
  - No posterior, no sample count, and no below-threshold number goes into the shape.
- **Tutor.** Add a "What students wrote" list on `src/app/(tutor)/tutor/courses/page.tsx`,
  with a report button on each note. The tutor's own two public numbers sit beside it.
  Nothing else: no position, no per-rating stars.
- **Rule copy.** Add one line on the tutor home (`src/app/(tutor)/tutor/page.tsx`):
  *"Students who book you again through Quad Tutor move you up for that course."*
  Ship it in the same PR as the renewal term, never before: until then the line would
  be false.
- **Ops.** `/ops/reports` lists rating reports beside thread reports, and the review
  form offers `removed`.

### Gate (Code reviewer)

- Grep the RSC payload of the course page for a tutor below each threshold: no
  average, no count.
- `TutorCard` gains only the two `PublicRating` fields.
- Nothing in `ratings/` imports or writes `reliability_event`, and nothing in
  `reliability/` reads `session_rating`.
- No rating value gates a tutor anywhere: no `where` on stars outside the aggregate.
- Every query carries `institution_id`.
- No surface shows a renewal rate, a trial count or a posterior, to anyone.

## Order

1. **Ratings.** Schema, capture, card and moderation. It is useful on its own,
   because the display reads live, and moderation has to be in before ratings reach
   students.
2. **Ranker.** The renewal columns, `scoring/`, the cron hook, the `score.ts` split
   and guard fix, and the tutor rule line. This PR is the whole ranking change.

The next item after both is direct mid-term renewal. Its proposal comes before it is
built.
