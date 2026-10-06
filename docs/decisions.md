# Decision record

Produced by a three-way design review (domain / architecture / UX), two rounds each.
Full source analysis in `docs/research/`. Where a decision came from independent
agreement between reviewers who could not see each other's work, that is noted — it
is the strongest signal in here.

Last updated: 2026-10-05.

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

**Paid first session under a self-serve refund guarantee** — not a free intro. Free
intros burn scarce supply on people who were never going to buy. On a refund the
platform eats the tutor's pay rather than clawing it back; protecting supply beats
recovering a few dollars. Cap at one guarantee per student per term.

**Unused sessions auto-refund at term end.** Breakage income is a trap on a campus
where everyone talks.

**A single session exists, but only as an end-of-term top-up.** One session, full
price, offered to a student who has finished a package with that tutor when fewer
weeks remain in the term than a package has sessions. It is not a cheaper door into
the product: a cold one-off has no dosage, a $3.50 take on a $35 session does not pay
for course-level matching, and a pair who met once has no reason to come back through the
platform. A renewal shares none of that — the matching cost is sunk, the tutor is
known, the dosage already happened, and the pair could already have left and did not.

What it fixes is the tail of the term, which the package shape gets wrong. A student
who used four sessions and wants one more before finals otherwise chooses between
another four-pack that mostly auto-refunds at term end and texting the tutor
directly. The second is free and easier, so the package rule was producing leakage at
the exact moment the relationship is worth most. Top-ups chain: a booked-but-unheld
session leaves nothing to book, so a second can be bought before the first happens,
which is what finals week actually looks like.

**The take is 10% of each session, capped at $100 per tutor per term.** The session
price stays $35 and the student pays nothing on top: a student booking fee was
rejected because the student is already paying for the tutor. Once a tutor's platform
share for a term reaches $100, they keep 100% for the rest of that term. This replaces
the flat 22%, which was too high. At $35 a session the cap is reached on the 29th
session — $1,000 of sessions, about $900 of it to the tutor. The ceiling is 100
tutors × $100 × 3 terms ≈ $30k a year, before processing.

The cap is the disintermediation lever, not just a discount. The tutor with the most
to gain from cash is the busy one, and past the cap that tutor's on-app sessions cost
them nothing. It supersedes a lower take on renewals only (question 4 in
`docs/proposals/off-platform-payment.md`).

Each rule below keeps the cap a sum over the ledger rather than a counter that can
drift:

- **Scope.** One meter per `tutor_profile` per `term`, across all of that tutor's
  courses and students. The term is the engagement's (`course_offering.term_id`), not
  the date the session settles, so a dispute resolved after term end counts against
  the term it was taught in.
- **Charged at recognition, never at purchase.** A package is deferred revenue, and its
  split is unknown until each session is delivered. The fee is fixed in `recognise()`
  (`engagements/confirmation.ts`), the one place a session becomes revenue — two
  confirmations, auto-release, or a dispute resolved as attended. It is written as a
  `platform_fee` row beside `session_earned` and `tutor_payout`, so every delivered
  session satisfies `session_earned = tutor_payout + platform_fee`, and the meter is
  the sum of `platform_fee` for that tutor and term.
- **Fixed once written.** A session's fee never changes after recognition. Nothing is
  re-priced retroactively, in either direction.
- **Reversals follow the tutor's pay.** A term-end refund returns only undelivered
  sessions, which never charged a fee, so it does not touch the meter. A guarantee
  refund does not give room back: the platform eats that refund rather than clawing
  back from the tutor, and returning cap room would make the tutor's next session pay
  for it — the same clawback by another route. A disputed session charges nothing while
  it holds; resolved as attended, it is charged at resolution against the meter as it
  stands then; resolved as not attended, never. Nothing today reverses a recognised
  session. If something ever does, and takes the tutor's pay back with it, it reverses
  the fee row too and the room returns.
- **Concurrency.** `recognise()` locks the `tutor_profile` row before reading the
  meter, so two sessions for one tutor recognised at the same moment serialise and the
  second sees the first's fee. Every path locks the session first and the tutor second.
- **Rounding.** Integer minor units only:
  `fee = min(floor(session × 1000 / 10000), max(0, 10000 − meter))`. Floor rounds in the
  tutor's favour, and the session that crosses the line takes a partial fee (the 29th
  at $35 pays $2.00), so the meter lands on exactly $100.00 and never over. A
  through-final session ($31.50) pays $3.15 and caps on the 32nd.
- **The platform absorbs card processing, before and after the cap.** "Keep 100%" is
  literally true. At Stripe's standard US card rate a $140 four-pack costs about $4.36
  to collect, roughly $1.10 a session: a third of the $3.50 fee before the cap and a
  straight loss after it, plus Connect's per-payout charge. Passing processing through
  to capped tutors was the alternative, and was rejected to keep the promise simple.
- **The guarantee's cost is accepted as is.** A guarantee refund now costs the platform
  the tutor's $31.50 plus processing, about nine sessions of fee where it used to be
  four. The guarantee terms are unchanged.
- **The tutor sees their own meter; no student ever does.** The earnings page shows
  progress toward the cap ("$64 of $100 this term"), because the incentive only works
  if a busy tutor knows how close they are. Whether a tutor is capped says how busy
  they are, which is an ordering, so it never reaches a student-facing shape or
  `score.ts`.

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
computed from those rows, never stored. When the last package ends the thread closes:
it still opens and shows its history, and the composer becomes a "Book another
package" prompt into the existing top-up or request flow. Booking again reopens it. A
tutor whose request auto-withdrew keeps a read-only thread.

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

- **No rating is public until the tutor has 10 delivered paid sessions**, in any
  course or courses. That holds for both the overall rating and every course rating.
- **Overall** shows when the tutor has at least 10 sessions *and* at least 5 ratings.
  It averages every rating the tutor has, across all their courses.
- **Course** shows when the tutor has at least 10 sessions *and* that `tutor_course`
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
- **The session a guarantee refunded can be rated.** It was delivered and recognised,
  and the platform paid the tutor for it. Excluding it would drop exactly the ratings
  that explain why someone asked for their money back.

**The window is 14 days from recognition**, the `session_earned` row's `occurred_at`.
That is long enough to answer after the exam and short enough that the rating is still
about the session. Nobody is nagged: there is one prompt, on the session page, and no
email.

**A student can edit their rating, stars and note, until the window closes.** After
that it is fixed. Changing your mind a day later is ordinary. Being lobbied by a
classmate a month later is what the lock prevents.

**Notes are tutor-only and anonymous.** They are never public. The tutor sees each
note, without the student's name or the session date, once its window has closed. The
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

**The ranker smooths the course rating toward the course mean.** The stats job writes
two fields on every active `tutor_course`, including those with no ratings:

- `score_sample_count` is the number of ratings.
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
  "New tutor" means fewer than 10 sessions or fewer than five ratings, and "New in
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
  never sees who gave which stars. Notes arrive anonymous and only after the window
  closes, the window shuts lobbying out, and there is no rating in the other direction
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
  has ended, `completed` or `refunded`. It counts per pair, so a student counts once.
- **A success** is that student buying another engagement from the same
  `tutor_course`. A top-up counts.
- **A guarantee refund counts as a failed trial.**

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
and this turns three or four of them a term into one. The end-of-term top-up rule is
unchanged. This settles the renewal half of the open question *Package length vs.
disintermediation*. The first-purchase default is still exam-anchored.

**Direct mid-term renewal is the next item after public ratings.** A pair renews with
the same tutor from their thread or the session page, without going back through the
deck or making a new request. The matching cost is sunk, which is the same reasoning
as the top-up. **The tutor's accept step stays.** Double opt-in holds on every
package, so a direct renewal is a request to this one tutor that skips the deck, not a
purchase the tutor never agreed to. The tutor also still needs open slots.

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

**Stripe is settled for the MVP but absent from the first draft.** Package purchase
writes real double-entry ledger rows now — deferred on purchase, recognised per
delivered session, tutor pay held until earned — with a single marked seam in
`engagements/purchase.ts` where the PaymentIntent goes. The money invariants are the
part that outlives any payment provider, so they get built and exercised first.

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
Known wage floor: UA on-campus ~$10/hr, America Reads/Counts $12/hr, athletics
tutoring $10–17.50. Target roughly 2×: **$25–30/hr to the tutor, $30–40 session price.**
The 20–25% take this originally targeted is superseded by 10% capped at $100 per tutor
per term (see Product) — well under Wyzant (~34%) and Preply (~33%).

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
