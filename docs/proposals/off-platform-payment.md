# Proposal: off-platform payment (cash under the table)

Status: **proposal, nothing settled.** Written 2026-10-04 against `origin/main` at
`ddb6d18`. Nothing here is recorded in `docs/decisions.md` until the user answers the
questions at the end.

## The item

> One issue came up with bypassing the application's payment system and going under
> the table with cash. We should have a ranking system for tutors and reviews can only
> be left by their clients if the student has submitted payment for a session.
> Rankings and reviews are the incentive to pay through app as this would help gather
> more students for tutoring sessions down the road. Or... we can lock tutoring to
> certain classes until they've accomplished X number of sessions tutored or courses
> tutored. We enforce this pre-requisite to make our tutors on-app more credible.

Two options: **(A)** public rankings and reviews, gated on paid sessions; **(B)**
course locks until a tutor has X sessions or courses behind them.

## Recommendation

**Neither as written. Keep the payment-gated half of A and drop the public half.**
Sessions paid and renewed through the app feed the *hidden* per-(tutor, course) score
that already orders the deck. Tutors are told the rule, but never shown their number
or their position. A tutor who takes a returning student to cash loses the one signal
that brings them new students from the app. The incentive A is after works because
the ranking moves the deck, not because the ranking is public.

**Reject B.** It cuts supply in exactly the courses the product exists for. It also
does nothing about cash: a locked-out tutor has *more* reason to tutor off-platform,
not less.

This is consistent with the open entry in `docs/decisions.md:299-301` ("price it in
rather than trying to build against it"). It polices nothing. It makes the on-app path
the one that pays the tutor back later.

## What exists today

- **The hidden score has columns but no writer.** `tutor_course.score_sample_count`
  and `score_posterior_mean` are at `src/server/db/schema.ts:318-319`. They are only
  read: `src/server/modules/matching/candidates.ts:74-75,106-107`. No job populates
  them. `docs/decisions.md:190-192` settled "ship the schema and the stats job now",
  and only the schema shipped.
- **The ranker already has a slot for it.** `src/server/modules/matching/score.ts:55-57`
  adds `posteriorMean × posteriorWeight` (weight 30, `score.ts:18`). Today that term is
  dead code because every row has `n = 0`.
- **A latent bug lands the day the writer ships.** The term only applies when
  `scoreSampleCount > 0` (`score.ts:55`). So a tutor with one *failed* trial gets
  `prior × 30` points, and a brand-new tutor gets 0. Fresh tutors would rank below
  proven-bad ones. That inverts the exploration principle in `docs/decisions.md:186-188`.
  Fix: a tutor with `n = 0` gets the prior.
- **Stripping already holds.** `src/app/(student)/courses/[offeringId]/page.tsx:44-53`
  maps `DeckCard` down to `TutorCard` (`tutor-picker.tsx:11-20`, a client file), and no
  score field crosses. Nothing in this proposal adds a field to `TutorCard`.
- **"Paid" means a ledger row today.** Stripe is not wired in. Purchase has
  `TODO(stripe)` seams at `src/server/modules/engagements/purchase.ts:189,311`, and the
  double-entry rows are real. Delivered sessions write `session_earned` /
  `tutor_payout` in `src/server/modules/engagements/confirmation.ts:21-47`. Any "only if
  they paid" rule keys on `engagement` / `ledger_entry` rows. Those rows stay correct
  once Stripe lands.
- **Renewal is the leakage moment, and the product already treats it that way.**
  Leakage concentrates at the package boundary (`docs/decisions.md:284-288`). Top-ups
  exist to stop leakage at term's end (`decisions.md:42-56`, `purchase.ts:319`). A
  closed thread turns its composer into "Book another package" (`decisions.md:150-155`;
  `src/server/modules/messaging/threads.ts:42-66,266-300`). Mid-term, that prompt sends
  the student back through the deck and a fresh request (`threads.ts:298-299`).
- **Tutor credibility is already gated per course.** A claim needs a verified A−/A/A+
  (`src/server/modules/tutoring/grades.ts:1`, `verification.ts:209-224`), and only
  `active` claims reach the deck (`candidates.ts:91`).
- **The money gap the tutor is weighing.** It is $35 a session with a 22% take
  (`src/server/modules/billing/pricing.ts:1-2,89-95`), so going cash gains the tutor
  about $7.70 per session.

## Option A against the record

| Part of A | Verdict | Why |
|---|---|---|
| Visible ranking | Conflicts | Per-course scores are hidden and stripped server-side (CLAUDE.md invariant; `decisions.md:186-188`). A shown rank fails the invariant's own test: a student can reconstruct an ordering from it. |
| Public reviews / stars | Conflicts | Rejected outright (`decisions.md:255-257`). A review count fails the same way a badge does: its absence is a signal. |
| Gated on payment | Keep | Using paid activity as the input is right. It just belongs in the hidden ranker. |

Beyond the conflicts, public reviews would not work here even if they were allowed:

- **They inflate to uselessness.** On a campus where the two parties share a lecture
  on Thursday, nobody writes the two-star review. Everyone gets five stars, and the
  stars carry no information.
- **They punish new supply.** A tutor with zero reviews sits under one with twelve.
  That is the cold-start starvation the bandit exploration was chosen to prevent.
- **They miss the leak.** Reviews reward winning *new* students. Leakage happens with a
  student the tutor *already has*, at renewal. A tutor can take the first package
  on-app, collect the review, and move the renewal to cash. The gate does nothing at
  the moment that matters.

## Option B against the record

- **Supply.** The deck holds about 5–20 tutors per course, and launch needs 20–50
  tutors in week one (`decisions.md:207-210`). Tutor churn is named as the failure
  mode that kills a campus (`decisions.md:290-297`). A tutor who cannot tutor the
  weed-out courses until they have done X sessions elsewhere has nowhere to earn X,
  because the seeded catalog *is* the weed-out courses (`decisions.md:58-59`).
- **Credibility.** The product's claim of credibility is "aced this course, under
  this professor" (verified grade plus professor match). Session count is the
  generalist marketplace's credential, which the wedge exists to beat.
- **Disintermediation.** It runs backwards. Off-platform has no lock, so a locked tutor
  has every reason to tutor for cash.
- **Exploration.** It is the hard-coded version of "new tutors starve at the bottom",
  which the scoring decision explicitly designs against.

## Other levers considered

| Lever | Verdict |
|---|---|
| **Paid renewals feed the hidden ranker** | **Recommended (MVP).** Detailed below. |
| Tell tutors the rule | **Recommended (MVP).** The incentive only works if tutors know about it. They see the rule, never their score or rank. |
| Lower take on same-pair renewals | Strong lever, but it is a money choice. It narrows the $7.70 gap exactly where leakage happens. Question 4. |
| Through-final as the default renewal offer | Turns 3–4 leakage moments per term into one (`decisions.md:284-288`). Product choice. Question 5. |
| Direct "renew with this tutor" mid-term, skipping the deck and a new request | Removes friction at the leakage moment. The top-up reasoning applies: matching cost is sunk. It is a bigger build, so post-MVP. Question 6. |
| Detect or redact contact details in messages | Reject. Message content never feeds anything (`decisions.md:174-177`). It is trivially bypassed, and the pair meets in person at session one anyway. |
| Report reason "asked to pay outside the app" | Reject for now. The student is usually the other beneficiary of the cash deal, so nobody files it. If staff acted on these reports, they would be issuing a tutor-side penalty from an accusation, not from a fact. |
| What the app already gives a student over cash | The refund guarantee, auto-refund at term end, dispute path and scheduling are already built. A tutor gets guaranteed pay, with auto-release on silence. Say this on the purchase screen. That is copy, not a build. |

## The signal: on-app renewal rate, per (tutor, course)

- **Trial.** A distinct student whose first engagement with this `tutor_course` has
  ended (`completed` or `refunded`). It is counted per *pair*, not per engagement, so
  one student, or one friend farming, counts once.
- **Success.** That student bought another engagement from the same `tutor_course`.
  A top-up counts.
- **Posterior.** Beta-binomial with the prior centred on the course mean:
  `(successes + α) / (trials + α + β)`, stored in basis points. With `n = 0`, the
  posterior equals the prior, which fixes the `score.ts:55` bug above.
- **A guarantee refund counts as a failed trial.** It is a fact, not a judgement, and
  the student keeps the refund regardless.

Why renewal, and not the alternatives:

- **It is revealed preference.** It cannot be inflated by social pressure the way
  stars can.
- **It is the exact event that cash removes.**
- **It costs real money to fake.** Gaming it takes two paid packages per fake student,
  and the platform keeps 22% of both.

Known noise: a student who passes the exam and stops reads as a non-renewal. That
affects every tutor in the course about equally, and shrinkage absorbs it at small n.

**What is deliberately not an input:** messages, blocks, reports, reliability events,
star ratings, free text. None of these move. Rich-get-richer exposure bias is real
(the top card gets more asks, so it collects more trials). The V1 bandit is the fix,
and it does not belong in this slice.

## MVP slice

| Part | Owner | Build |
|---|---|---|
| Schema | Database engineer | **No migration.** Columns exist (`schema.ts:318-319`). Confirm `engagement_tutor_course_idx` covers the aggregate, and review the query plan. |
| Pure posterior | Backend engineer | `src/server/modules/scoring/posterior.ts`: no I/O, no clock, unit-tested. It sits outside `matching/` so `score.ts` stays the pure ranker. |
| Stats job | Backend engineer | `src/server/modules/scoring/stats.ts`: one institution-scoped `UPDATE tutor_course … FROM (aggregate)`. It writes every active claim, including `n = 0` (which gets the prior). |
| Ranker fix | Backend engineer | `score.ts:55`: drop the `scoreSampleCount > 0` guard. The job guarantees a value is present. Keep `null` meaning "no term" for safety. |
| Sweep | Distributed-systems engineer | Call the job per campus in the `/api/cron` loop (`src/app/api/cron/route.ts:45-49`). It is a full recompute, so it is idempotent and safe to overlap. A 15-minute cadence (`.github/workflows/cron.yml:23`) is more than enough, and no read-path call is needed. |
| Tutor copy | Web engineer | One line on the tutor home (`src/app/(tutor)/tutor/page.tsx`): *"Students who book you again through Quad Tutor move you up for that course."* No number, no rank, no per-student breakdown. |
| Gate | Code reviewer | `TutorCard` gains no field. No tutor-facing surface shows score, sample count or position. No stats query can read across institutions. |

Out of the slice: questions 4–6 (pricing, renewal default, direct renewal) and the V1
bandit.

## Invariant and decision conflicts

- **None for the recommendation.** It builds the stats job that `decisions.md:190-192`
  already settled, and it keeps the score hidden.
- **Tenant key.** `engagement`, `tutor_course` and `ledger_entry` carry no
  `institution_id` (`schema.ts:290-326,392-426,486-503`). They are scoped through
  `tutor_profile`. This predates the item, but a campus-wide write job is where
  forgetting it costs the most: the stats `UPDATE` must join `tutor_profile` on
  `institution_id`. Whether to add the column to those tables is a separate item.
- **Option A conflicts** with the hidden-score invariant and with the rejection of
  public star ratings. Option B conflicts with the exploration principle in the scoring
  decision.

## Changes to `docs/decisions.md` if accepted

1. **Scoring, tutor side.** Define the input. The hidden per-course score is the
   on-app renewal rate per (tutor, course), Beta-binomial shrinkage toward the course
   mean, with `n = 0` scored at the prior. Tutors are told the rule and never their
   score or position.
2. **Rejected.** Add *Payment-gated public reviews*: they inflate to five stars on a
   campus, starve new tutors, and miss renewal, which is where leakage actually
   happens. Add *Course locks by sessions tutored*: they cut weed-out supply and push
   locked tutors to cash. Add *Contact-detail filtering in messages*.
3. **Open, disintermediation generally.** Append the renewal-signal mechanism as the
   chosen response, and keep "price it in" as the stance. Record the answers to
   questions 4–6, whatever they are.

## Questions for the user

1. **Public rankings and reviews stay rejected?** Recommend yes: hidden ranker only.
   Strongest alternative: private, payment-gated "would you book them again?" asked
   once per package, which feeds only the hidden score. It is more signal, but it is a
   subjective input and a prompt nobody enjoys.
2. **Reject course locks (Option B)?** Recommend yes. Strongest alternative: a soft
   cap on *parallel engagements* for a tutor's first term, rather than a course lock.
   It still costs supply, and the guarantee already covers a bad first session.
3. **Tell tutors that on-app renewals raise their ranking?** Recommend yes, rule only.
   Alternative: say nothing. That avoids gaming talk, but then the incentive does not
   exist for anyone who does not already know.
4. **Money: lower the take on same-pair renewals (for example 22% to 15%)?** Recommend
   not yet. Revisit once renewal rates exist to compare against. Alternative: ship it
   now, because renewal is exactly where leakage concentrates and the reduced take is
   cheaper than the lost package.
5. **Product: offer "through the final" first when an existing pair renews mid-term?**
   Recommend yes. It collapses several leakage moments into one. Alternative: keep
   exam-anchored as the default everywhere, for consistency and a smaller ask.
6. **Product: direct mid-term renewal with the same tutor, skipping the deck and a new
   request?** Recommend yes, but as the next item rather than this one. Alternative:
   leave it as the request flow, which keeps double opt-in fresh each package.
