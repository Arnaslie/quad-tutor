# Decision record

Produced by a three-way design review (domain / architecture / UX), two rounds each.
Full source analysis in `docs/research/`. Where a decision came from independent
agreement between reviewers who could not see each other's work, that is noted — it
is the strongest signal in here.

Last updated: 2026-09-19.

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
the product: a cold one-off has no dosage, a 22% take on $35 does not pay for
course-level matching, and a pair who met once has no reason to come back through the
platform. A renewal shares none of that — the matching cost is sunk, the tutor is
known, the dosage already happened, and the pair could already have left and did not.

What it fixes is the tail of the term, which the package shape gets wrong. A student
who used four sessions and wants one more before finals otherwise chooses between
another four-pack that mostly auto-refunds at term end and texting the tutor
directly. The second is free and easier, so the package rule was producing leakage at
the exact moment the relationship is worth most. Top-ups chain: a booked-but-unheld
session leaves nothing to book, so a second can be bought before the first happens,
which is what finals week actually looks like.

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

**Intake under 45 seconds.** Course selection is the primary input (schedule
screenshot → OCR, with catalog type-ahead as fallback); section and professor are a
required second step. Everything the course code already answers is cut.

### Scoring

**Tutor side: hidden per-course quality score.** Bayesian shrinkage toward the mean at
low sample counts, plus bandit-style exploration so new tutors get real shots instead
of starving at the bottom. Never publicly visible.

**At launch n=0 for everyone, so MVP ranking is a deterministic sort.** Ship the
schema and the stats job now; the Bayesian ranker lands in V1. A learned ranker is
18+ months and several campuses away.

**Student side: reliability only** — attended, late-cancelled, no-showed, payment
failed. Timestamped facts, nothing subjective. Surfaced as platform mechanics
(deposit required, fewer parallel asks), never as a badge or number, always
recoverable in ~3 clean sessions. Prevention (T-12h confirm, auto-release, check-in)
comes before any penalty.

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

**Public star ratings.** Nothing to compare against under a ranked deck, and it
imports every marketplace pathology. Note that positive-only badges do not solve this:
the *absence* of a badge is itself a signal.

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
Price it in rather than trying to build against it.

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
tutoring $10–17.50. Target roughly 2×: **$25–30/hr to the tutor, $30–40 session price,
20–25% take** — beating Wyzant (~34%) and Preply (~33%).

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
