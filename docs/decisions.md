# Decision record

Produced by a three-way design review (domain / architecture / UX), two rounds each.
Full source analysis in `docs/research/`. Where a decision came from independent
agreement between reviewers who could not see each other's work, that is noted — it
is the strongest signal in here.

Last updated: 2026-10-18.

---

## Settled

### Product

**College students only. No K-12, no minors.** Payer and user are the same person.
This removes guardianship, versioned consent, background checks, COPPA, mandated
recording and parent dashboards from scope entirely.

**Single campus first — University of Alabama — expanding campus-by-campus.**

**Course-scoped, not subject-scoped.** Matching keys on course / section /
professor. This is the wedge.

**Peer tutors.** Students who took the course recently, ideally under the same
professor.

**Exam-anchored packages, not time subscriptions.** Default is ~4 sessions to the
next exam (~$120–160), with "through the final" as a discounted upsell. *Converged
independently:* domain reached it from conversion timing (people buy right after a
bad exam grade, not in week one), UX from the renewal curve (this is a sawtooth, and
the renewal moment is course registration, not a billing date).

**The first session is paid, with no refund guarantee and no free intro.** Free
intros burn scarce supply on people who were never going to buy. The self-serve
first-session guarantee was removed on 2026-10-08 (see Reversed): buying a session
is a commitment, and a delivered session stays paid.

**A student can end a package early** (user, 2026-10-08). This replaces the
guarantee as the way out of a bad fit. Ending runs the term-end refund on demand:
- The sessions not yet delivered are refunded and the delivered ones stay paid.
- Future bookings are cancelled and the tutor is emailed for each, as for any
  on-time cancel.
- The package closes as `completed` if anything was delivered, otherwise as
  `refunded`.

It moves only deferred money: no fee, no payout, and the fee meter is not touched.
Ending writes no reliability fact. It is refused while a session is inside the
late-cancel window, past its start and unconfirmed, or disputed. A late cancel stays
something only the cancel action records, and a session that may have happened is
never refunded. Only the student can end their package.

**Unused sessions refund at term end, or when the student ends the package.**
Breakage income is a trap on a campus where everyone talks.

**A single session exists, but only for an existing pair.** One session, full
price, offered to a student whose packages with that tutor in a course have nothing
left to book, at any point before the term ends. Revised 2026-10-08: it used to be
an end-of-term top-up only (see Reversed). It is not a cheaper door into the
product: a cold one-off has no dosage, a $1.75–$3.50 take on a $35 session does not pay
for course-level matching, and a pair who met once has no reason to come back
through the platform. Cold one-offs stay rejected. A renewal shares none of that —
the matching cost is sunk, the tutor is known, the dosage already happened, and the
pair could already have left and did not. None of those reasons depend on the
calendar, so the refill does not either.

What it fixes is the gap after a package, which the package shape gets wrong. A
student who used four sessions and wants one more before the next exam otherwise
chooses between another four-pack that partly auto-refunds and texting the tutor
directly. The second is free and easier, so the package rule was producing leakage
at the exact moment the relationship is worth most. Refills chain: a
booked-but-unheld session leaves nothing to book, so a second can be bought before
the first happens, which is what finals week actually looks like.

The refill books straight into one of the tutor's published open slots, with no
accept step: the tutor already offered that hour, and one session commits them to
nothing beyond it. A package needs the tutor's accept (see Renewals).

**Tutors set their own rate for each course they tutor, in whole dollars from $1 to
$200 a session. The take is 10% of each session until the platform has taken $100 in
fees from a tutor, counted over the tutor's whole life on one campus, and 5% of every
session after that, for good.** Settled 2026-10-16 (`docs/proposals/lifetime-fee-milestone.md`).
It replaces the 10-session step from 10% to 5% and the $100-per-term cap, and applies to
existing tutors with no grandfathering. The student pays the tutor's rate and nothing on top: a student
booking fee was rejected because the student is already paying for the tutor. The price
is fixed when the tutor accepts the request, or when a top-up's checkout is created, and
a later rate change never re-prices it. The meter never resets at term end, and there
is no 0% rate. The rate is shown to students and is never a ranking input. The $200
ceiling is a fraud guard, not a market limit: without it, a stolen card and a colluding
tutor could move large sums through payouts.

Price decides when a tutor crosses $100: the 29th session at $35, the 67th at $15, the
10th at $100 and the 5th at $200. Busy tutors pay 5% for good instead of 0% past a
term cap. The cap was the main reason a busy tutor had nothing to gain from moving
students to cash. The user accepted losing that lever on 2026-10-16, and the lower
rate is the one that is left. The old cap and its worked figures are in
`docs/proposals/tutor-pricing.md`, kept as history.

Each rule below keeps the meter a sum over the ledger rather than a counter that can
drift:

- **Scope.** One meter per `tutor_profile`, across all of that tutor's courses,
  students and terms. A `tutor_profile` belongs to one campus, so the meter is per
  campus. `milestoneReached()` in `billing/pricing.ts` is the only place "$100
  reached" is decided, and `feesToDate()` in `billing/ledger.ts` is the only read of
  the meter. Nothing stores the answer.
- **Charged at recognition, never at purchase.** A package is deferred revenue, and its
  split is unknown until each session is delivered. The fee is fixed in `recognise()`
  (`engagements/confirmation.ts`), the one place a session becomes revenue — two
  confirmations, auto-release, or a dispute resolved as attended. It is written as a
  `platform_fee` row beside `session_earned` and `tutor_accrued`, so every delivered
  session satisfies `session_earned = tutor_accrued + platform_fee`, and the meter is
  the sum of `platform_fee` for that tutor.
- **Fixed once written.** A session's fee never changes after recognition. Nothing is
  re-priced retroactively, in either direction. Fees written under the old cap and
  step stay as they are. If `FEE_MILESTONE_MINOR` is raised later, tutors between the
  old and the new line go back to 10% (accepted 2026-10-16).
- **Reversals follow the tutor's pay.** A term-end refund, and a package the student
  ends early, return only undelivered sessions, which never charged a fee, so
  neither touches the meter. A disputed session charges nothing while it holds;
  resolved as attended, it is charged at resolution against the meter as it stands
  then; resolved as not attended, never. Nothing today reverses a recognised session.
  If something ever does, and takes the tutor's pay back with it, it reverses the fee
  row too and the meter drops by that fee.
- **Concurrency.** `recognise()` locks the `tutor_profile` row before reading the
  meter, so two sessions for one tutor recognised at the same moment serialise and the
  second sees the first's fee. Lock order, per path:

  | Path | Order |
  |---|---|
  | `requestTutors`, `requestRenewal` | `student_profile` (no key update), then the student's pending `match_request` rows (for update) |
  | `acceptRequest` | `student_profile`, then that `match_request` (for update of `match_request`) |
  | `purchasePackage` | `tutor_profile` (no key update), then `match_request` |
  | `purchaseTopUp` | `tutor_profile` |
  | `bookSession` | `engagement` (for key share; re-read, refused unless `active`), then `tutor_profile` |
  | confirm / `recognise()` | `session_booking` (for update), then `tutor_profile`, then `engagement` (no key update) |
  | term-end refund | `engagement` (for update), then its scheduled `session_booking` rows |
  | `endPackage` | `engagement` (for update), then its scheduled `session_booking` rows, only after refusing any session a confirmation could hold (inside 12h, started but unanswered, or disputed). Shares `closeWithRefund` with the term-end refund |
  | `fulfilCheckout`, `releaseCheckout` | `engagement` (for update; returns unless `pending_payment` and the Checkout Session id matches), then its `held` `session_booking` rows. An amount or currency mismatch cancels both and inserts a `money_discrepancy` row in the same transaction |
  | card refund (after `closeWithRefund` commits: `after()` in `endEarly`, the term-end sweep, the retry sweep, refund webhooks) | none. Reads the unstamped `refund` row, calls Stripe, then stamps `re_…` with `where stripe_reference is null`. The retry sweep runs each campus under a `sweep_lease` row (a timestamp claimed by one conditional upsert, not a lock) |
  | transfer sweep | `engagement` (no key update) alone. Re-reads what is owed and the pause after the lock, inserts the unstamped `tutor_transfer` row and commits; Stripe is called after commit, and the stamp `where stripe_reference is null` is the only guard after that. Each campus runs under its own `sweep_lease` row |

  The rules behind it:
  - Student before request; tutor before request.
  - A path that locks an engagement before the tutor (`bookSession`) takes it only for
    key share. Key share does not conflict with confirmation's no-key update of the
    engagement after the tutor.
  - Nothing holds the tutor while waiting on an engagement for update, or on a
    session. `setDefaultLocation` (`tutoring/location.ts`) also takes the tutor first.
- **Rounding.** Integer minor units only, and floor rounds in the tutor's favour.
  Below the line a session pays `floor(session × 10%)`, and past it
  `floor(session × 5%)`. The session that crosses the line is split at it, like a tax
  bracket: 10% on the part whose fee fills the meter to exactly $100, and 5% on the
  rest, so no fee above $100 is charged at 10%:
  `fee = toLine + floor((session − toLine × 10) × 5%)`, where `toLine = 10000 − meter`.
  With $98 already taken, a $35 session pays $2.00 on its first $20 and $0.75 on the
  other $15, a $2.75 fee, and the meter ends at $100.75. It is still one `platform_fee`
  row and one payment, since the split is recomputable from the session amount and the
  meter before it. A through-final session at $35 ($31.50) pays $3.15, then $1.57.
- **`db:check-money` guards the tutor's side.** Each fee is at most 10% of its session.
  Per tutor, take the fees charged above 5%; their sum minus the largest of them must
  stay under $100. The meter only grows, so the last of those sessions saw at least
  that much. The check needs no row order. Old rows pass it unless a tutor paid more
  than $100 at 10% across terms under the old cap, which only a tutor charging over
  about $111 a session could do; the prod check-money run before this shipped is what
  rules that out. It catches repeated overcharges, not a single 10% fee smaller than
  the largest earlier one. The other direction, 5% charged too early, is left to the
  tests, because rows written under the old cap break it by design.
- **The platform absorbs card processing.** At Stripe's standard US card rate a $140
  four-pack costs about $4.36 to collect, roughly $1.10 a session: a third of the $3.50
  fee below the milestone and about two thirds of the $1.75 after, plus Connect's
  per-payout charge. Passing processing through to tutors was rejected to keep the
  price simple. Low rates lose money too: a
  single session pays for itself at about $4.25 a session at 10% and $14.30 at 5%, and a
  four-pack at about $1.05 and $3.60. Below that, the platform pays to collect. The user
  accepted this on 2026-10-15 rather than raise the $1 floor, since rates that low will be
  rare.
- **The tutor sees their own meter; no student ever does.** The sessions page shows
  progress toward the milestone ("$64.00 of $100.00"), then that 5% applies for good.
  The fee number never reaches a student-facing shape or `score.ts`.

**Seed ~10–30 weed-out courses. Not the full catalog.** Concentration buys patience;
a full catalog is vanity work.

### Matching and interaction

**A deck of every available tutor for the course**, ranked, no filters — the course
code already did the filtering. Because scoping makes the catalog small (~5–20),
"show everything" and "curated shortlist" are the same list.

**Up to 3 parallel asks; first tutor to accept wins; the rest auto-withdraw.** This
is the important one. A right-swipe on Tinder works because it is a cheap, parallel,
non-exclusive signal — not a choice. A single exclusive request turns the swipe into
a proposal and leaves the student waiting on one busy 20-year-old while their exam is
Thursday. Parallel asks convert the wait from "will anyone say yes" to "who says yes
first."

**Presentation is a function of supply count** — a hard rule, not a preference:

| Tutors | Treatment |
|---|---|
| 0 | Demand capture: notify, adjacency ladder (professor → course → department), referral bounty |
| 1–2 | Not a deck — single-tutor reveal. A two-card stack advertises your own thinness |
| 3+ | Deck with a visible `1 of N` counter |

Stating the count up front turns thinness into completeness: *"that's all of them"*
reads honest, *"that's all we found"* reads broken.

A consequence of that rule, made real by the deck filtering out the viewer's own
tutor profile: **the same offering can present differently to different students.**
A course with three tutors, one of whom is the student looking at it, is a
`single_reveal` for her and a `deck` for everyone else. That is the rule working
rather than an artifact — the count stated has to be the count the viewer can
actually ask, or the honesty the rule buys is spent. It does mean the presentation
is a property of (offering, viewer), not of the offering.

**Double opt-in.** The tutor accepts too. On the tutor side an explicit pass costs
nothing, ever; silent expiry carries a ranking penalty. Requests expire at 12h.
Punishing declines makes tutors accept students they cannot serve.

**A request names its package.** The student picks exam-anchored or through the
final when asking, and the tutor sees the number of sessions before accepting,
because accepting commits them to that many sessions and slots. A tutor who can fit
three sessions can decline an eight-session ask at no cost, like any pass. Checkout
buys exactly the requested package. Decided 2026-10-08. Requests made before then
carry no package and keep the free pick at checkout.

**Charge only after the tutor accepts and a slot is picked** — never at request time,
or double opt-in generates a refund queue in week one.

**Attendance settles on facts, and money defaults where silence is cheapest to
undo.** This was the open adversarial-confirmation question; it is now built, and the
shape is worth stating because each half is load-bearing:

- Both parties answer. Two confirmations settle it; the confirmation window is 24h
  and a lapse auto-releases to *attended*, which pays the tutor.
- **Auto-release moves money but writes no reliability fact.** Money can default on
  silence because a wrong default is refundable. A fact cannot: an `attended` row
  minted from nobody answering is fiction, and it would quietly clear a student's
  strikes.
- Denial is asymmetric by role. A tutor's denial means *the student did not show*; a
  student's means *it did not happen*. That asymmetry is what lets a `no_showed` fact
  exist without anyone rendering a subjective judgement.
- Confirm against deny is a dispute. It holds — no money moves, and no sweep ever
  resolves it. A human does, at launch volume.
- **The two answers are shown to both parties; the written note is not.** Who said
  what and when are timestamped facts, and each side is entitled to them. The
  `denial_note` is one party's account kept for whoever settles the case: putting the
  accusation in front of the accused turns a disagreement into a fight, on a campus
  where these two people have a class together on Thursday.

The residual risk is unchanged and unsolved: this is still the weak point of the
no-video decision, and it is the reason the dispute path exists rather than a
tiebreaker rule.

**The tutor owns the meeting spot**, so the student sees where they will meet before
paying. A tutor sets a default spot once and every booking copies it onto the session
(`session_booking.location`). Three rules:

- The student can send the tutor a note but never sets the place.
- Changing the default never moves a session already booked.
- Every save of the default fills upcoming sessions that have no spot yet.

The tutor can move a single session, but not inside the late-cancel window
(`LATE_CANCEL_HOURS`): a student sent somewhere new at short notice who goes to the
old spot would be recorded as a no-show the platform caused. A move after the booking
email has gone out, whether by hand or by the fill, emails the student the new spot.

**Every session state change is an email, not a page to check.** Booking from the
tutor's posted hours needs no second confirmation, so "booked" means confirmed for both
and both are emailed. A cancel emails the other party. When a session ends, whoever
has not answered is asked whether it happened, and the settled result goes to everyone
except the person whose answer settled it (they saw it on screen). Each send takes a
ten-minute lease on the row (`notify_claimed_at`), sends with a Resend idempotency key,
and only then stamps its timestamp, so the sweep and the `after()` call from the action
that caused it send once between them, and a send cut off mid-flight is retried once the
lease lapses (Resend dedupes the key for ~24h). Request emails work the same way on
`match_request`. One lease per row means a second kind of email for the same row can
wait for the next sweep. The booked and moved keys carry `location_changed_at` and a
hash of the spot, so a reused key whose body has since changed (Resend's
`invalid_idempotent_request`) can only mean the wording changed, and counts as delivered. The copy
never mentions late cancels or no-shows: those are reliability facts and stay unseen.
These are not filtered by blocks — a block stops messages, not word of a session that
was paid for.

**Intake under 45 seconds.** Course selection is the primary input (schedule
screenshot → OCR, with catalog type-ahead as fallback); section and professor are a
required second step. Everything the course code already answers is cut.

### Messaging

**One thread per (student, tutor-course) pair, opened by the first request.** The
thread is created inside the request transaction, so a thread exists only once a
request does. There are no cold messages: nobody can write to a tutor they have not
asked, and a tutor cannot write to a student who has not asked them. Keying on
`tutor_course` rather than the tutor keeps the pair the same unit as everything else.

**Writable while there is something between them.** A pending request, an accepted
request not yet bought (inside its term), or an active package. Writability is
computed from those rows, never stored. When the last package ends the thread closes,
but it still opens and shows its history. While the term runs, the student sees "Book
again" (see Renewals) once the pair has nothing left to book, whether the thread is
open or closed. After the term ends, a closed thread points to the course list. A
renewal request or a refill reopens the thread. A tutor whose request auto-withdrew
keeps a read-only thread.

**Staff read reported threads only, and every read is logged.** An operator sees
reports for their own campuses and can open the reported thread; each open writes an
append-only `message_thread_access` row. The composer says plainly that a reported
conversation can be read by staff. Nothing else gives staff message content.

**The email alert carries a one-line preview**, about 80 characters with an ellipsis.
A thread where either party has blocked the other gets no preview and no email.

**One email per burst.** At most one per thread per recipient every 15 minutes, and a
new one only after the recipient has read what the last one was about. The email goes
out right after the message via `after()`, with the cron sweep as a backstop. Both
paths claim with one conditional update on the thread (the pacing condition is in the
`where`), send with a Resend idempotency key, and release on failure — so overlapping
runs send once. No real-time transport: a server-rendered thread and a server action
are enough at one campus, and a push channel would be a second system to keep
authorised.

**Blocks and reports are not reliability.** A block stops messages both ways and
removes the tutor from that student's candidates and from demand-capture coverage — a
filter, never a score. Neither ever writes `reliability_event` or reaches `score.ts`,
and message content never feeds matching or any score.

**A deleted account keeps its messages.** The sender shows as "Deleted user"
(`message.sender_user_id` is set null on delete). There is no account deletion yet;
when there is, it has to decide what happens to the profiles, which still reference
the user without a cascade.

### Scoring

**Tutor side: hidden per-course quality score.** Bayesian shrinkage toward the mean at
low sample counts, plus bandit-style exploration so new tutors get real shots instead
of starving at the bottom. The score is never publicly visible. Since 2026-10-05 it has
two inputs: the course star rating, which has a public face past a threshold (see
Ratings), and the on-app renewal rate, which never does (see Renewals).

**At launch n=0 for everyone, so MVP ranking is a deterministic sort.** Ship the
schema and the stats job now; the Bayesian ranker lands in V1. A learned ranker is
18+ months and several campuses away.

**Student side: reliability only** — attended, late-cancelled, no-showed, payment
failed. Timestamped facts, nothing subjective. Surfaced as platform mechanics
(deposit required, fewer parallel asks), never as a badge or number, always
recoverable in ~3 clean sessions. Prevention (T-12h confirm, auto-release, check-in)
comes before any penalty.

### Ratings

Decided 2026-10-05. This reverses the rejection of public star ratings (see Reversed)
and answers question 1 of `docs/proposals/off-platform-payment.md` ("Public rankings
and reviews stay rejected?"): **no.** The proposal recommended a hidden ranker only;
the user chose public, payment-gated ratings instead, as the incentive to stay
on-app. Build brief: `docs/proposals/public-ratings.md`.

**Only a student who paid rates, once per session, 1–5 stars, with an optional short
note.** A paid session is a delivered, recognised one: it has a `session_earned`
ledger row. Ratings go one way. Tutors never rate students; rating students by ability
stays rejected.

**Two public ratings, an overall one and one per course.** A tutor can be strong in
Calc I and weak in Organic, so the course rating is the one that matters on a course's
deck, and the overall rating sits beside it.

- **No rating is public until the platform has taken $100 in fees from the tutor**,
  in any course or courses: the same fee milestone that lowers the take (Product).
  That holds for both the overall rating and every course rating. Settled 2026-10-16
  (`docs/proposals/lifetime-fee-milestone.md`); it replaces a 10-session gate. Price
  decides how fast a tutor is rated: after the 29th session at $35, the 67th at $15,
  the 10th at $100 and the 5th at $200.
- **Overall** shows when the tutor is past the milestone *and* has at least 5 ratings.
  It averages the ratings in those of the tutor's courses whose own rating is public
  (see the aggregates rules below).
- **Course** shows when the tutor is past the milestone *and* that `tutor_course`
  has at least 5 ratings. The threshold counts ratings, not sessions in the course:
  five sessions can carry one rating, and "5.0 · 1 rating" is the number this
  threshold exists to prevent.
- Requiring 5 ratings for the overall rating too stops it from showing "2.0 · 1
  rating". It also stops it from revealing, for a tutor with one course, a course
  average that is still below its own threshold.
- **Shown as average and count**, e.g. "4.7 · 12 ratings", the average to one decimal.
  Below its threshold a rating reads "New tutor" (overall) or "New in this course",
  and its average and count never leave the server.

**Which sessions can be rated.**

- **Only sessions settled as attended**: `session_booking.status = 'completed'`, which
  covers both confirmations, auto-release, and a dispute resolved as attended. A
  disputed session can be rated only once it resolves as attended. Cancelled sessions
  and disputes resolved as not attended never can.
- **An auto-released session can be rated.** The money moved and the session is
  recognised. A rating writes no reliability fact either, so it cannot launder a
  silence into an `attended` row.

**The window is 7 days from recognition**, the `session_earned` row's `occurred_at`.
It was shortened from 14 days on 2026-10-06. That is long enough to answer once the
session has sunk in, and short enough that the rating is still about the session.
Nobody is nagged: there is one prompt, on the session page, and no email.

**A student can edit their rating, stars and note, until the window closes.** After
that it is fixed. Changing your mind a day later is ordinary. Being lobbied by a
classmate a month later is what the lock prevents.

**Notes are tutor-only and anonymous.** They are never public. The tutor sees each
note, without the student's name or the session date, once it is released (below). The
delay is what makes it anonymous: a tutor with one session last Tuesday can tell who
wrote it, and the window cannot be lobbied once it has shut. The tutor sees the same
two public numbers students see, and never the stars on any single rating.
Public notes, meaning reviews, were the alternative. They are more useful to a student
deciding, but they put a peer's written account in front of the whole campus, and
every one becomes a moderation case.

**Moderation reuses the `message_report` flow.** A tutor can report a note from where
they read it. It lands in the same `/ops/reports` queue, scoped to the operator's
campuses, with the same reasons. A new outcome, `removed`, takes the whole rating out
of every aggregate. It is for ratings that are not about the session, or that are
harassment, or retaliation in either direction. A low score on its own is never
grounds for removal.

**What the aggregates count.** Settled 2026-10-06, from the ratings code review.

- **The gate, restated.** No rating, overall or course, is public until the tutor has
  paid $100 in fees. After that, a course rating needs at least 5 ratings in
  that course, and the overall rating needs at least one course whose rating is
  public. `publicRating()` asks the same `milestoneReached()` that sets the take, so
  the two cannot drift apart. The fee number never leaves the server. Only its effect
  crosses, a rating or "New tutor", as with the 10-session gate before it, and
  `score.ts` does not read fees.
- **Only released ratings are counted** (batches decided by the user, 2026-10-06).
  This replaces "only ratings whose window has closed". A rating's 7-day window must
  close before it can be released, and released is what counts. That applies to:
  - the course average and count;
  - the overall average and count;
  - both thresholds;
  - the tutor's notes.

  A sweep releases a course's closed, unremoved, unreleased ratings together. The
  first release for a `tutor_course` needs at least 5 (`MIN_RATINGS`), so the course
  rating goes public with its first batch. After that, a release needs at least 3
  (`RELEASE_BATCH`).

  Why batches: counting closed ratings still added each one at a predictable moment,
  7 days after its session. A tutor could read one student's stars off the change in
  the totals, and the note appeared at the same moment. A batch mixes at least 3
  ratings into every change.

  The cost is accepted. Public numbers can lag until a batch fills, and a course with
  few sessions may wait until term end.

  **Leftovers are released at term end** (user, 2026-10-06). A course's waiting pool is
  also released once the term of every rating in it has ended, if it holds at least 2
  ratings (`TERM_END_MIN`). The term is the engagement's (`course_offering.term_id`).
  The normal 5/3 rule is unchanged, so a term-end release is only ever a pool that
  rule would not release. A pool of 1 is never released, at term end or after; it
  waits for later ratings in the same course to join it. Released ratings still have
  to reach 5 before the course rating is public, so a term-end batch can show the
  tutor its notes without the course going public.

  Accepted risk: a term-end batch of 2 lets a tutor narrow down which of two students
  gave which stars and note. The user chose that over losing the feedback.

  The term-end release waits for the term's last rating window to pass too: it runs
  from `term.ends_on` + 7 days + 1 day. Sessions held in finals week are still inside
  their window when the term ends. Waiting lets them join the leftovers, so the term's
  last ratings release in one batch rather than two. This is a timing clarification
  that follows from the user's rule, not a new decision.

  Not covered, and accepted: when an operator removes a rating, the totals change
  immediately. That only happens when an operator acts.
- **The hidden ranker counts released ratings only, too** (user, 2026-10-06). The
  stats job applies the same predicate to `score_sample_count`, `score_posterior_mean`
  and the course and campus prior means. That gives one definition of a counted
  rating. A deck position that moved when a single rating closed would be the same
  live signal the batches exist to remove.
- **The overall rating counts only courses whose own rating is public.** If it
  averaged every course, a tutor with one public course and one below its threshold
  could subtract the public course from the overall and recover the hidden one. With
  this rule the overall rating is built only from numbers that are already public,
  and it stays "New tutor" until at least one course rating is public.
- **Opening a rating report is audited, like a thread report.** Each time an operator
  opens a rating report, an append-only access row records the operator, the report
  and the time, the same way `message_thread_access` does for threads.
- **Staff see a rating's note only through a report** (user, 2026-10-06). Every such
  view is logged in `session_rating_access`.

**The ranker smooths the course rating toward the course mean.** The stats job writes
two fields on every active `tutor_course`, including those with no ratings:

- `score_sample_count` is the number of ratings (released ratings only; see above).
- `score_posterior_mean`, in basis points of the 1–5 scale (1★ = 0, 5★ = 10 000), is
  the Bayesian average `(m·C + Σ stars) / (m + n)`, where:
  - `m = 5`, the same as the display threshold;
  - `C` is the mean of every rating in that course on that campus;
  - if the course has fewer than 20 ratings, `C` is the campus mean, and below 20 on
    the campus, it is 4.0★.

With n = 0 the posterior is the prior, so an unrated tutor ranks as an average one,
not a bad one. That means the `scoreSampleCount > 0` guard in `score.ts` goes. The
term gets 15 of the slot's 30 points; renewals get the other 15 (see Renewals).

Campus inflation compresses real averages into roughly 4.5–5.0★. At weight 15 that is
about two points of score against 40 for a professor match, so stars nudge the deck
rather than rule it. Revisit the weight with real data. The rest of the formula stays
hidden: professor match, grade, recency, the silent-expiry penalty, the renewal term,
and the weights. Exploration for new tutors is still the V1 bandit.

**Ratings never feed reliability**, on either side. They are subjective, and
reliability is timestamped facts only. A rating never writes a `reliability_event`,
never reaches the student's standing, and is never written from one.

**A rating can be a reason for a student not to book a tutor. It is never a gate on
the tutor.** No average delists, hides, caps, deposits, delays a payout, or limits the
parallel requests of anyone. Its only effects are the number on the card and the
posterior term in the ranker. A tutor leaves the platform for conduct, through
reports and a human, never for an average.

**The old objections, answered honestly:**

- *The absence of a rating is itself a signal.* Accepted, because of the threshold.
  "New tutor" means under $100 in fees or fewer than five ratings, and "New in
  this course" means either of those or fewer than five ratings in the course. All of
  them are volume facts, not quality judgements, and the ranker scores
  them at the prior, so on the deck "new" is not "bad". A student may still prefer the
  rated tutor. That is the price of the decision, and the bandit is what spends
  exposure on new tutors deliberately.
- *Rating inflation.* Expected. On a campus nearly everything will be 4.5 or above,
  and the public average will carry little information. Its count, and the line
  between "new" and "rated", carry more. The ranker is relative to the course mean,
  so inflation compresses the term rather than swamping the other inputs. Payment
  gating and one rating per session stop the cheapest inflation, friends rating
  friends for free.
- *Rating a peer.* The rater and the rated may share a class on Thursday. The tutor
  never sees who gave which stars. Notes arrive anonymous and only in released
  batches, the window shuts lobbying out, and there is no rating in the other direction
  to trade against.
- *New: tutors avoiding struggling students.* With double opt-in, a tutor protecting
  an average can decline the students most likely to rate them low on a bad exam.
  That is the inversion the ability-rating rejection exists to prevent, arriving by
  another route. It is not solved here. Watch the decline rates once there is data.

### Renewals

Decided 2026-10-05. These are the answers to questions 3, 5 and 6 of
`docs/proposals/off-platform-payment.md`. Question 2 is under Rejected. Question 4 is
the take cap under Product.

**Renewing through the app raises a tutor's ranking, and tutors are told so.** The
proposal's signal is the on-app renewal rate per (tutor, course):

- **A trial** is a distinct student whose first engagement with that `tutor_course`
  ran: it ended `completed`. It counts per pair, so a student counts once. A first
  package refunded under the former guarantee (removed 2026-10-08) is still a trial,
  so past trials do not shift.
- **A first package the student ended early follows the term-end rule.** With
  sessions delivered it ends `completed`, so it is a trial. Without a later purchase
  it is a failed one. With nothing delivered it never ran, so it is not a trial.
- **A first package refunded at term end with no session delivered is not a trial**
  (user, 2026-10-07). The package never ran, so it says nothing about whether the
  student would come back. That holds even if the pair bought again later: the pair
  has no trial. A term-end refund with sessions delivered ends the package as
  `completed`, so it is a trial like any other.
- **A success** is that student buying another engagement from the same
  `tutor_course`. A top-up counts.
- **A historical guarantee refund counts as a failed trial**, unless the pair bought
  again.

Renewal is the event that cash removes, and it costs two paid packages to fake.

**Stars and renewals are two separate hidden terms, 15 points each.** They split the
30 that the posterior slot had, so earned signals carry the same weight against
professor match and grade as before. Both are smoothed toward the course mean with
prior strength 5, and both fall back from course to campus once there are fewer than
20 samples:

- **Stars:** see Ratings.
- **Renewals:** a Beta-binomial `(successes + 5·C) / (trials + 5)`. The last-resort
  prior is 0.4, a placeholder until there is data.

They are not blended into one number. They have different scales, different priors
and different failure modes: stars inflate, and renewals read a student who passed and
stopped as a loss. Keeping them apart lets either weight be tuned without re-deriving
the other. The rejected alternative was to keep stars at 30 and add renewals at 30 on
top, which would make earned signals rival a professor match.

**Tutors get the rule, never the number.** One line on the tutor home: *"Students who
book you again through Quad Tutor move you up for that course."* The tutor sees no
renewal rate, no trial count and no position. The renewal term never reaches a student
in any form, and like ratings it never feeds reliability or gates anyone.

**A mid-term renewal offers "through the final" first.** When an existing pair books
again with exam-anchored sessions still possible, "through the final" is the default
and the exam-anchored package is the second option. Each renewal is a leakage moment,
and this turns three or four of them a term into one. One more session is the third
option (see Product). This settles the renewal half of the open question *Package
length vs. disintermediation*. The first-purchase default is still exam-anchored.

**Direct mid-term renewal: one "Book again" entry.** Decided 2026-10-08. Build
brief: `docs/proposals/direct-renewal.md`. From the thread or the session page,
once the pair's packages in the course have nothing left to book and the term has
not ended, the student sees three options in this order: through the final,
exam-anchored, one more session. The matching cost is sunk, which is the same
reasoning as the refill.

- **A package is a request to this one tutor that skips the deck.** It is an
  ordinary `match_request` that names its package (see Matching). It has the same
  12h expiry and silent-expiry penalty and the same accept and decline. It is one
  of the student's parallel asks. It is charged only after the accept and a slot
  pick. Double opt-in holds on every package, because a package is a commitment
  the tutor has to agree to.
- **One more session books directly** into one of the tutor's published open
  slots, with no accept step (see Product).
- **Both count as a renewal success** for the ranker. Like the rest of the renewal
  term, neither ever reaches the student or the card.
- **A blocked pair gets neither**, and neither does a tutor whose claim on the
  course is no longer active.

### Technical

**Next.js only. No Python service.** Extraction seam documented in `CLAUDE.md`.

**`institution_id` on every scoped table from migration #1** — about a day of work,
turns campus #2 from 2–4 weeks into days, and closes a silent cross-campus leak risk.

**Postgres + Drizzle, Neon in deployed environments** (branch-per-PR is the reason).
**Better Auth** self-hosted. **Stripe Connect Express in the MVP** — a campus launch
needs 20–50 tutors in week one — but **KYC deferred to the first accepted request**,
not signup, so friction doesn't land on the bottleneck.

**Sessions are wherever the pair chooses. No video product.** Attendance is confirmed
in-app by both parties.

**One mobile-first responsive Next.js app — not a separate native client.** Every
screen is authored at 390px and laddered up; parity between phone and desktop is
structural rather than a checklist, because there is one route tree and one build. A
second Expo/React Native client would mean a second auth integration, JSON endpoints
in place of server actions, and roughly double the first-draft time, to reach students
who are already on the web app.

**Stripe is wired through hosted Checkout, and a purchase is pending until paid.**
Buying a package, a renewal or one more session writes an engagement in
`pending_payment` and a `held` session that blocks the slot, and no ledger row. One
idempotent fulfilment, reached from the webhook or from asking Stripe (the return page,
the student's reads, the sweep), flips both live and writes `package_purchase` against
the PaymentIntent. A redirect is never proof of payment. A checkout is released only
after Stripe says it is dead, so a payment can never land on a released slot. A released
checkout is `cancelled` and counts as nothing: not a purchase, not a trial, not a
renewal. The ledger is typed single-sided rows summed by type, not double-entry.

**Separate charges and transfers, each transfer bound to its charge.** Destination
charges need an onboarded tutor at charge time, KYC is deferred past the first accept,
and the take is only known per session at recognition. Transfers carry
`source_transaction` and `transfer_group = engagement_id` and send `Σ tutor_accrued`; the
take meter never reaches Stripe. The ledger owns what is owed; Stripe owns what moved;
`stripe_reference` is unique. The pay-owed row is `tutor_accrued`, not `tutor_payout`:
in Stripe a payout moves a connected balance to a bank, and this row moves nothing.

**No Stripe call holds a row lock.** The locked transaction writes the ledger row with
no reference; the call follows the commit with the row id as its idempotency key; the
reference is stamped once, conditionally. That stamp is the only update a ledger row
ever takes. Lock order adds: fulfil and release take the engagement (for update), then
its held sessions; the transfer sweep takes the engagement (no key update) alone.

**Refunds reach the card after commit, and a failed one goes to ops for good.**
`closeWithRefund` writes the `refund` row under its lock with no reference. After commit,
every attempt first lists the PaymentIntent's refunds: one carrying this row's id in
metadata is stamped; a live one that is not ours (a Dashboard refund) writes a discrepancy
on the row and nothing is created. Otherwise it creates on `refund:<ledger_entry_id>` and
stamps the `re_…`. A row the after-commit call left unstamped is retried by the sweep after
a 5-minute grace, on the same base key, so an overlapping call gets Stripe's 409 (left for
the next pass) or its answer. Only when Stripe answers the base key from its idempotency
cache (`Idempotent-Replayed: true`) with a 5xx does the retry move to
`refund:<id>:<hours since the row>`, since Stripe keeps a failed response for 24h.
`charge.refunded` and the refund events re-read the refund and stamp the row. Engagements
bought before Stripe have no `pi_…` and are never sent. Stripe keeps the processing fee on a
refund, so a payment refunded with nothing booked still writes its `processor_fee`.

Two retry sweeps never run one campus at once: each claims a `sweep_lease` row (campus,
name, `held_until`) with one conditional upsert and releases it at the end, and a sweep
that cannot claim skips the campus. A Postgres advisory lock was rejected because holding
it means an open transaction across the Stripe calls; the lease is a timestamp, holds no
lock, and lapses after five minutes if its holder dies. The Stripe client times out a
request at 15s, so one request with its two network retries takes at most about 45s. A
row can make up to five requests (list, create, list, suffixed create, list), about four
minutes at worst, which the five-minute lease and grace cover; the cron's 60s limit ends a
run sooner, and its lease then lapses.

Only a 400 or 402 from Stripe is a refusal; 401, 403 and 404 are logged and retried. The
one exception: a PaymentIntent Stripe still does not know a day after the row was written,
on an engagement with no `processor_fee` row (no charge was ever recorded, as with seeded
`pi_test_…` ids), is flagged `refund_failed` so it is not retried forever. A PaymentIntent
with a fee is never flagged on a 404, so a key for the wrong account cannot flag paid
refunds en masse. A refusal first re-lists the refunds and settles with ours if Stripe
already holds one. A refund refused with none, or that fails later (closed or lost card),
writes a `refund_failed` discrepancy keyed on the PaymentIntent, and the row keeps any
`re_…` it was tried against.

Code never re-sends a refund to that card. A discrepancy carries `ledger_entry_id` when it
is about a ledger refund row (a failure or a foreign refund), and any discrepancy on a row
stops that row's automatic refund whether or not it is resolved. A refund of a payment
that was never booked has no row; a `refund_failed` on its PaymentIntent stops that
PaymentIntent's refunds the same way. The halt is per row or per PaymentIntent, never per
engagement: a failed refund of a stray payment on a superseded Checkout Session does not
hold up the engagement's own term-end or end-early refund. The retry sweep reports rows it
skips as `blocked`, so a halted row stays visible in the cron response. A Dashboard refund
that fails has no row of ours, so its `refund_failed` names only the PaymentIntent. It holds
the engagement's own refund rather than stopping it: the term-end or end-early refund waits,
counted as `blocked`, until ops answers the flag, so it is not sent to a card that just
bounced one. Resolving the flag releases that refund to the card. Settling it by hand
stamps the held refund row `manual:<discrepancy id>` in the same transaction, so it stays
the engagement's one refund and no sweep sends it; settled before the package ends, there
is no row yet and the flag only resolves. A row that fails on a `refund_failed` ops already
resolved reopens it at that row's amount, because the money it names is new. So does a
further Dashboard refund that fails on the same PaymentIntent, at its own amount, and it
holds the package refund again. The flag records the id of every refund whose failure it
carries in `failed_refund_ids`, and only a refund not in that list is news: the
reconciliation replays every failed refund on the PaymentIntent each day, so an amount
cannot tell a new failure from an old one, and two failures of different amounts would
reopen the flag every day. A reopen keeps the note ops resolved it with, unless the news
is a row of ours failing. So a flag that names the package refund and still carries a note
was answered after that refund failed, and its card does not ask ops to pay it again. A
newest-failure test cannot tell this: a Dashboard refund that bounces before ops answers
would read as answered. Ops pays the
student another way and records it with `recordManualSettlement` in `billing/ops.ts`
(formerly `recordManualRefund`), which resolves the discrepancy and, when it names an
unstamped refund or transfer row, stamps that row `manual:<discrepancy id>` in the same
transaction. A row Stripe stamped in the meantime refuses the settlement, since the money
moved there. A flag on a refund made in the Dashboard instead stamps the row with that
refund's `re_…`, since it is the refund that happened, so the reconciliation counts it and
the row references the Stripe object. The row keeps its amount, as a stamp is the only
update a row takes: a Dashboard refund smaller or larger than the row leaves the
difference on the PaymentIntent's charge flag, which ops clears by refunding the rest in
the Dashboard or resolves. The row stays the engagement's one row of its kind, no sweep
sees a stamped row, and `db:check-money` accepts only `re_…` or `manual:…` on a refund
row. A flag naming an unstamped refund or transfer row can only be settled, never just
resolved: resolved, the row would stay stopped, unsent and unstamped for good, and the
transfer sweep would count it as sent.

**Tutor pay moves in the sweep, not inline, and is never clawed back by code.**
Transfers go per engagement once the tutor is verified and the engagement has no open
discrepancy or dispute. Refunds return only undelivered sessions, so none needs a
reversal. Bank payouts are weekly unless the tutor picks daily (below). Reversals are an ops tool. A reversal books a
`transfer_reversal` row and leaves that money owed to the tutor until ops acts; the sweep
never re-sends it. Ops answers each reversal once, on `/ops/money`, with a `tutor_transfer`
row of its amount whose `corrects_entry_id` names it; a unique index on that column makes a
second answer a refusal. Re-send leaves the row unstamped and sends it after commit, with
the sweep as backstop, and is refused while the engagement is paused. Paid by hand stamps
it `manual:<reversal id>`; written off stamps it `forfeited:<reversal id>`. The sweep's
owed amount leaves out both the reversal and its answer, so the two cancel and a later
accrual goes out at its own amount. Earnings count `tr_…` and `manual:…` as transferred,
less reversals, and `forfeited:…` as neither transferred nor owed.

**KYC never blocks an accept.** An unverified tutor's pay accrues and
waits, and the student's sessions proceed. Hiding unverified tutors from decks was
rejected: they would never get the accept that triggers onboarding. The Express account is created
when the tutor starts payout setup from `/tutor/payouts` (its button, or Stripe's
`refresh_url`), never on viewing the page and never inside an accept, with transfers only
and a weekly payout schedule (Fridays); onboarding collects `eventually_due` fields up front so a
later threshold doesn't restrict the account. `kyc_status` is re-derived from Stripe's
account on every `account.updated` and every view of that page, never from the event
payload. An account the tutor hasn't submitted is `not_started` even though Stripe lists
its fields as past due; one Stripe is still reviewing (`pending_verification`,
`under_review`) is `pending`, since the tutor has nothing to fix; any other disabled
reason or past-due field is `restricted`.

**Bank payouts are weekly by default, and daily is free too (2026-10-18, the owner's
request).** Each tutor has a `payout_speed`: `weekly` (the default, every Friday) or
`daily` (every business day). The tutor picks it on `/tutor/payouts`. This replaces
"bank payouts are daily". The owner asked for weekly free with faster tiers costing more,
the way Venmo does it. Daily is free anyway, because Stripe lets a platform charge only on
Instant Payouts, through the Platform Pricing Tool's application fee; a standard payout has
no fee hook. Charging for daily would mean a new ledger row taken out of earned pay, which
the "never clawed back by code" rule above forbids, and a new ledger type. Daily costs the
platform about 25¢ for each extra payout: Connect charges 0.25% + 25¢ a payout, and the
0.25% is the same on the same total either way. A tutor paid every weekday costs about $1
a week more than weekly. The paid, faster tier is an instant cash-out, built separately.

The stored speed is the truth and Stripe is made to match it, never the reverse. Every
`account.updated`, every view of `/tutor/payouts` and every pick reads the account,
compares its schedule with the stored speed, and calls Stripe only when they differ. No
row lock is held across that call. Accounts made while payouts were daily move to weekly
this way, with no script. A schedule this app does not offer, such as `manual` set in a
Dashboard, reads as no speed and is put back. The update carries no fixed idempotency key:
it sets an absolute value, so a repeat is harmless, while a key per speed would replay a
stale answer after a switch back within 24 hours. A failed schedule update is logged and
never blocks the KYC sync; the next event or view tries again.

**A chargeback is recorded, not judged.** It pauses that engagement's
transfers and goes to ops; it writes no reliability fact on its own. Each dispute event
re-reads the dispute and upserts one `payment_dispute` row for the engagement its
PaymentIntent bought. Stripe closing it (won, lost) sets `closed_at`, and the daily
reconciliation re-reads open disputes so a missed close event still lands. Only ops lifts
the pause, by setting `resolved_at`, and only once Stripe has closed the dispute, since what
a lost dispute means for the tutor's pay is ops' call. A
transfer Stripe refuses for an account it still verifies is flagged as a discrepancy
too, which pauses the engagement the same way; one refused because the account lost
verification waits, and goes out once Stripe verifies it again.

**CI and local dev run on a signed fake, not Stripe.** One gateway module is the only
importer of `stripe`. Its fake signs real webhook events with the configured secret, so
verification and idempotency are tested with no Stripe secret in CI. It is refused in
production, like the email and proof-store fallbacks. One daily job is the exception:
`stripe-smoke` runs the real gateway against test mode, and imports `stripe` itself only to
charge `pm_card_visa` and to make the verified test account it transfers to, two things the
app leaves to Stripe's hosted pages. That account carries no `institution_id`, so it is
invisible to the app: reconcile looks for orphaned accounts one campus id at a time, and the
Connect webhook answers "foreign" to an account without a campus uuid.

**Ledger and Stripe are reconciled daily and never auto-corrected.** A divergence becomes a
discrepancy, which pauses that engagement's transfers and goes to `/ops/money`. The
reconciliation runs in the cron under its own lease, in two loops per campus. Every run
compares up to 20 engagements bought through Stripe, with ledger activity in the last week
and not compared in the last day, then stamps `reconciled_at`. Each is asked about once a
day, spread over the runs, and one that fails is asked again on the next run. The comparison
checks the charge net of refunds, each refund's status, and the transfers net of reversals,
and books a missed transfer or reversal event as the webhook would. There is one flag per
kind and Stripe object: a repeat leaves an open flag alone, and reopens a resolved one only
when the gap between its two amounts has moved, so a second Dashboard refund a month later is
news and the same divergence seen again is not. The gap decides, not the two amounts: a
500 transfer gap ops resolved as a bonus stays resolved when the next session's transfer
moves both sides by the same amount, and does not pause the tutor's pay again. A transfers gap has no one Stripe object, so its flag is
keyed on the transfer group, the engagement's id, in `stripe_reference`; without that key a
gap ops resolved was raised again the next day and paused the tutor's pay again. A claim held for 23 hours gates the daily pass, and is
let go only when the key check fails or the deadline cuts the pass short, so the next run
tries again instead of the next day. The pass settles flags Stripe can now answer,
re-reads open disputes, and flags Connect accounts carrying the campus's id that no tutor
holds (`orphaned_account`, which names no engagement and pauses nothing). The accounts are
listed once per cron run, for every campus, and the flag resolves itself once a tutor on
the campus holds the account. That flag reopens if the account is later held by no tutor
again, since it has no amounts to move. One ops resolved stays resolved: ops answered it
while no tutor held the account, so seeing it unheld again is not news.

A PaymentIntent Stripe does not know, on a purchase it charged (one with a `processor_fee`),
means the key is for another account. The campus run stops with nothing flagged and counts
as failed, since mass flags from a key mistake would bury real ones. A refund or transfer
row unstamped for over a day is flagged `unstamped_reference` without naming the row: a
discrepancy on a row stops its retries for good, and this one should only be seen. For the
same reason that kind does not pause transfers (`paused()` leaves it out), so the retry that
clears it keeps running. The daily pass resolves it once every row carries its Stripe
reference, and resolves a released checkout's flag once a day has passed and Stripe holds
no payment for it. A resolution by the reconciliation leaves `resolved_by_user_id` null.
Every ops write records the acting operator, in `resolved_by_user_id` on the flag or dispute
it resolves and in `recorded_by_user_id` on a row it appends.

**Data from before Stripe is test data, and it is cleared before launch.** Every
production account is a test account today, and no purchase before Stripe was charged.
Those ledger rows include sessions recognised under the old 22% take with no
`platform_fee` row (4 in production on 2026-10-09), which the money check flags. They
are deleted before go-live rather than corrected or exempted, so the check needs no
legacy carve-out. As a backstop, the transfer sweep never sends money for an engagement
whose `package_purchase` has no Stripe reference.

**Test users in production carry fixture money until launch.** Personas
(`persona_<key>` users, plus-aliases of the owner's inbox) are built by a reset on
`/ops` while `TEST_PERSONAS` is on. Their history is recorded with `fixture_`
references and no Stripe charge, through the same functions as real money. Fixture
money never reaches Stripe: the transfer sweep and refunds refuse `fixture_`
references, and the money check accepts them only between personas. Everything a
tester does is real Stripe test-mode money. At launch, `TEST_PERSONAS` is removed and
every `persona_` user is deleted. This is not a legacy carve-out: like the pre-Stripe
rows, it is gone at launch. Sign-in links go to the one inbox. Decided
by the user on 2026-10-14.
Every email to a persona is also copied (bcc) to `jmgucius@crimson.ua.edu`, so the
second tester reads persona mail without the shared inbox. `jmgucius@crimson.ua.edu`
is a reader, not a fixture person, so the rule that fixture people are plus-aliases of
`SEED_INBOX` still holds. Only addresses of `persona_` users are copied; other
`arnutislie12+` accounts, such as the operator, are not. Sign-in links are copied too,
so the second tester can sign in as any persona. That part is temporary: revert it by
2026-10-17 22:19 CDT (-0500), 48 hours after the user decided it (#92).

**Campus membership is gated on `crimson.ua.edu`**, the UA *student* domain, matched
against `institution.email_domain`. One domain per institution: supporting several
means that column stops being a single text field, which is not worth doing before a
campus needs it.

---

## Rejected, and why

**BetterHelp's one-assigned-provider model.** A therapist covers a whole person; a
tutor does not cover a whole student. Subjects change by term.

**Open marketplace browse.** Two-sided cold start, no moat, sells hours rather than
outcomes. Course scoping gets the benefit without the cost.

**Elo ratings (both sides).** Elo needs a contest with a winner. A tutoring session
has no win/loss, so any outcome you feed it is just an average with extra steps. Data
is far too sparse to converge, and cold start is badly handled.

**Rating students by ability — rejected on principle.** It would route the best tutors
to the strongest students and the worst to the students who most need help, inverting
the purpose of the product.

**"Preparedness" as a reliability component.** It requires a tutor's subjective read
and proxies for ability — the student who didn't attempt the problem set often
*couldn't*. It reintroduces the ability rating through the back door.

**Lifetime pricing.** Real marginal cost per session — it would be a liability that
grows with usage, and "lifetime" is meaningless to someone who graduates in four years.

**Large upfront as the first ask.** Cash-constrained buyers who haven't met the tutor.

**Paid-acquisition-funded growth.** BetterHelp's own numbers show it breaking: segment
revenue down 9% to $717M over the first nine months of 2025, paying users 415k→397k
YoY, with the CFO on record that more ad spend inflates CAC.

**Background checks.** They buy nothing once minors are out of scope. `.edu`
verification plus per-course grade proof replaces them.

**Nullable `user_id` / a dormant `guardianship` table "kept cheap for later."** A
nullable FK is `string | null` in every inferred type and every join, forever — paid
daily for a ruled-out scenario.

**Course locks until a tutor has X sessions or courses (2026-10-05, question 2 of
`docs/proposals/off-platform-payment.md`).** They cut supply in the weed-out courses,
which are the whole seeded catalog, so a locked tutor has nowhere to earn X. Session
count is the credential of the generalist marketplace, the one the wedge exists to
beat, and a locked-out tutor has more reason to tutor for cash, not less. A verified
grade and a professor match are the credibility gate.

---

## Reversed

**Public star ratings — rejected at design, reversed 2026-10-05.** The original
rejection: *"Nothing to compare against under a ranked deck, and it imports every
marketplace pathology. Note that positive-only badges do not solve this: the absence
of a badge is itself a signal."* The user reversed it: a tutor with 10 paid sessions
has had enough reps to be judged on them, and a public rating that only paid sessions
can earn is the reason to keep sessions on the app. The objections are answered, or
accepted with their cost stated, under Ratings.

**Single session only as an end-of-term top-up — settled at design, revised
2026-10-08.** The original rule offered one session only when fewer weeks remained
in the term than a package has sessions. The user revised it: the reasons a
renewal is worth having (matching cost sunk, tutor known, dosage happened, the pair
stayed) hold all term, and the gap after any package is a leakage moment, not just
the last one. Cold one-offs stay rejected. The current rule is under Product.

**Self-serve first-session refund guarantee — settled at design, reversed
2026-10-08.** The original rule: *"Paid first session under a self-serve refund
guarantee — not a free intro. On a refund the platform eats the tutor's pay rather
than clawing it back. Cap at one guarantee per student per term."* The user removed
it: "if you buy a session, you're committing, no free lunch." The column and ledger
type stay for history, and past guarantee refunds keep their meaning in the renewal
trial count. Ending a package early (see Product) is the way out of a bad fit
instead: it refunds only what was not delivered. The paid-first-session rule and
the rejection of free intros stand.

---

## Open questions

**Venture-scale or profitable at a few campuses?** D2C campus-by-campus grows linearly
in launch labor, which is likely why Knack converted to institutional sales. These are
different companies with different funding paths. Decide deliberately rather than
drifting.

**Package length vs. disintermediation.** Prepaid packages *are* the anti-leakage
mechanism — a student who has paid for four sessions won't defect mid-package, so
leakage concentrates entirely at the renewal boundary. Exam-anchored 4-session
packages therefore create 3–4 leakage moments per semester where "through the final"
creates one. Conversion and retention pull in opposite directions here. Not resolved.

**A late cancel costs the student nothing and pays the tutor nothing.** It writes the
timestamped fact and moves no money. Charging for it was rejected because a fee is an
unrecoverable consequence and reliability consequences must always be recoverable —
but that leaves a tutor who blocked 9pm on a Tuesday and was cancelled at 8pm earning
zero. With 15 tutors in week one, tutor churn is the failure mode that kills a campus;
student leakage is not. The alternative is to consume the session and pay the tutor,
which trades an unrecoverable money consequence for supply protection. Revisit with
real cancellation data, deliberately — this is currently a default, not a decision.

**Disintermediation generally** — now the top business risk, and not solvable by
engineering. Two adults on one campus with no safeguarding reason to stay on-platform.
Price it in rather than trying to build against it. The take cap (see Product) is the
pricing half of that.

**Course catalog ingestion.** UA reportedly runs Banner 9, whose
`StudentRegistrationSsb` JSON endpoints are said to be reachable across 750+
institutions — which would make the scraper a reusable expansion asset. *Verify access
terms before depending on this.* Per-section exam dates usually live in PDF syllabi;
assume manual entry for the seeded courses.

**Tutor wind-down on graduation.** ~4-semester tutor lifespan with recency decay, and
a wind-down at ~6 weeks so nobody is orphaned mid-package. Mitigation worth building:
make the *course* the durable asset rather than the tutor — session artifacts feeding
a per-course knowledge base. Converts graduation from existential to an onboarding
cost, and it is a moat a pure booking layer does not have.

---

## Outstanding actions (not answerable from a keyboard)

**1. Does UA already contract Knack, Upswing or TutorMe?** Knack is this exact
business — founded in UF's incubator in 2016, started explicitly D2C with students
paying out of pocket, went grassroots onto 100+ campuses, then moved the payer to the
institution and is now institution-funded and free to students ($540K UF deal, Series
B 2025). Their pitch line is this wedge verbatim. If UA has signed, you would be
launching paid against free with an identical value proposition. **Answer this before
writing feature code.**

**2. Validate willingness to pay.** Ask students in the target courses whether they
have ever paid for help in *that* course. Under roughly 1 in 10 — don't build.

Context: only 13% of students engage campus academic support and 34% know it exists
(Tyton, Sept 2024), against gateway DFW rates of ~29.4% in intro chem and ~47% in
Calc I. The gap is real, but 13% cuts both ways — it may mean the binding constraint
is help-seeking behavior rather than cost. **The initial market is students already
paying, not non-consumers.**

**3. Get the real course codes and the CAS peer-tutor pay rate** from the UA contact.
Known wage floor: UA on-campus ~$10/hr, America Reads/Counts $12/hr, athletics tutoring
$10–17.50. Target roughly 2×: **$25–30/hr to the tutor, $30–40 session price.** The
20–25% take this originally targeted is superseded by 10%, then 5% once a tutor has
paid $100 in fees (see Product) — well under Wyzant (~34%) and
Preply (~33%).

**4. Clear pre-Stripe test data from production before launch.** Every account is a
test account and no pre-Stripe purchase was charged (see Technical). Wipe it before
real students sign up, then run `db:check-money` against production and expect zero
violations.

**5. Turn off the tutor's own payout controls in the Express Dashboard.** At
dashboard.stripe.com/settings/connect/express-dashboard/features, disable changing the
payout schedule and manual payouts, so `/tutor/payouts` is the only place a tutor picks a
speed. A schedule changed there anyway is put back on the next sync.

---

## A note on expansion

Campus-by-campus is **franchising, not network effects.** Course catalogs, brand,
supply and social distribution all reset at campus #2; only the product and the
playbook transfer (~50–70% of the effort, estimated). Consequences: UA must be
profitable standalone, the scaling constraint is launch labor rather than software,
and the real asset to build at Alabama is a repeatable launch process.

**Two places assume a single timezone, and they are the ones to fix first.** The
campus IANA zone lives on `institution.timezone` and is read nowhere: slot generation
in `engagements/purchase.ts` builds times in the server's local zone, and the UI
formatters take `America/Chicago` from a `CAMPUS_TIME_ZONE` constant. Both are
correct for one campus in Central time and both are marked. Every formatter already
accepts a `timeZone` override, so the fix is to carry the zone on the actor rather
than to rewrite the call sites — cheap now, and a silent wrong-time bug if it is
found later by a student in Arizona.

The instructive analogy is not Facebook — it's **Yik Yak**, which died of campus
bubbles emptying at summer and graduation. That is precisely this product's
seasonality and churn profile.
