# UX & Experience Design — Tutor Helper Finder

**Author:** UX/UI workstream · **Date:** 2026-09-18 · **Status:** Opinionated v1 proposal, to be reconciled with DOMAIN and ARCHITECTURE tracks.

This document takes positions. Where a position depends on a founder decision that has not been made, the assumption is stated inline in an `> ASSUMPTION` block and the alternative design is sketched. All open decisions are collected in §11.

---

## 0. The headline verdict

**Assigned match, with a visible bench.** The user answers a short intake and we say *"We found your tutor — this is Maria."* One tutor, named, with a face, a credential, an intro video, and a bookable slot. Directly beneath that, two clearly-labelled alternates: *"Two others also fit — take a look."* One tap swaps. Zero search box, zero grid of 40 faces, zero filter sidebar.

This is neither BetterHelp's pure assignment nor Wyzant's marketplace. It is assignment as the **default path** and browsing as the **escape hatch**, and the asymmetry is the whole design. Rationale in §2.

Everything else in this document follows from that choice. If the founder overrules it and picks a marketplace, §2.4 describes what changes — it is not a small edit, it re-cuts the pricing model, the onboarding, the tutor dashboard and the trust surface.

---

## 1. Who the users actually are

### 1.1 The three primary personas

**The Parent (K-12 buyer).** Pays, does not attend. Typically 38–52, finds us on mobile via search or a friend, often at 9pm after a bad report card or a failed test. Her emotional state is *mild guilt plus urgency*. She is not shopping for a tutor; she is shopping for the end of a problem. She wants three things, in order: (1) reassurance that a stranger near her child is safe, (2) evidence that money produces results, (3) not to have to manage it. She will never open the app more than twice a month — which means **the product reaches her, not the other way around**: email and SMS are her real interface, and the web app is where she lands when she taps a link in one.

**The Student (the actual user).** Two sub-segments that behave very differently:
- **Ages 11–14 (middle school).** Does not want a tutor. Was told they are getting one. Low agency, some shame. Design goal: make the first session not embarrassing, and make the tutor feel like a cool older sibling rather than a second teacher. Session length 45 min max; attention is the constraint.
- **Ages 15–18 (high school).** Has real agency and real motivation, usually exam-shaped (SAT/ACT, AP, A-level, IB, Abitur). Often co-decides the tutor choice with the parent. Lives entirely on a phone. Will absolutely message the tutor at 11:40pm the night before a test — and that async lane is the single most-loved feature of the whole product if we build it right.

**The Tutor (supply).** Usually one of: a current university student (cheap, relatable, flaky), a working/retired teacher (expensive, reliable, credentialed), or a career tutor (the best cohort — treat them as the core). What they want, in order: (1) **predictable income**, (2) **not doing admin**, (3) students who show up and do the work, (4) status. What kills them: silence during vetting, empty calendars, chasing payment, no-shows they do not get paid for. Supply-side UX is §4 and it is first-class.

### 1.2 Secondary and internal personas

- **The Adult/University learner.** Self-buyer, no safeguarding overhead, higher willingness to pay, different subject mix. Cheapest persona to serve but the smallest and least defensible market. **Out of primary focus for V1**, but the data model must not exclude them (see 1.3).
- **The Matching Operator (internal).** In V1 the "algorithm" is a ranked shortlist plus a human who confirms it in under 90 seconds. With fewer than ~200 tutors, an algorithm will be worse than a person, and the failure mode (a bad first match) is the single most expensive event in the funnel. The admin match queue is a **V1 screen, not a V2 nice-to-have**.
- **The Trust & Safety Operator (internal).** Handles reports, recording access requests, credential expiry. Also V1.
- **School / district administrator.** Explicitly **out of scope for V1**. Noted because B2B2C is the obvious Series-A pivot and the data model should keep an `organization` seam.

### 1.3 The payer/user split — the most consequential IA decision

The account model must be **Household → Learners**, not `User`:

```
Household (billing entity, owns the subscription)
 ├── Adult member(s)      role: payer / guardian     — full billing, full oversight
 ├── Learner profile A    age 14, subject: Algebra II  — own login, own inbox
 └── Learner profile B    age 17, subject: AP Chem     — own login, own inbox
```

An adult self-buyer is a household of one where the payer and the learner are the same person. This costs maybe two days upfront and is agonising to retrofit once you have billing history, message threads and safeguarding logs keyed to a flat user table. **Flag to ARCHITECTURE: one human may hold multiple roles, one subscription may span multiple learners, and message-thread visibility is a per-learner ACL driven by the learner's age.**

> **ASSUMPTION A1 — Parents are in scope for V1, and under-18 learners are the core market.** This is the expensive choice: it adds background checks, recording, parental consent, age-gated messaging visibility and COPPA/GDPR-K considerations, which I estimate at 3–4 weeks of dedicated design and build. It is the right one, because the K-12 parent is the buyer with the money, the urgency and the retention.
>
> *If overruled (adults only for V1):* drop recording-by-default, drop the parent dashboard, drop the guardian consent flow, collapse Household to User, and the whole thing ships perhaps six weeks earlier — but you are then competing with Preply on price with no differentiation.

### 1.4 Consequences of the split, by surface

| Surface | Parent sees | Student sees |
|---|---|---|
| Onboarding | Does the intake *about* the child; invites the child in | Receives an invite, does a short "about you" of their own |
| Dashboard | Outcomes, attendance, spend, next session, safety status | Next session, homework due, message thread, progress map |
| Notifications | Weekly digest + billing + missed session + monthly report | Session reminders, homework nudges, tutor replies |
| Messaging | Own thread with the tutor. **Cannot read the student↔tutor thread verbatim** if learner is 13+ (see §8.3) | Own private-ish thread with the tutor |
| Billing | Everything | Nothing. Students never see a price. |

That last row matters. A 15-year-old who knows the session costs €55 behaves differently and worse — performing engagement out of guilt. Keep money entirely on the parent's side of the wall.

---

## 2. The fork: assigned match vs marketplace

### 2.1 Why BetterHelp's assignment works, and which reasons transfer

BetterHelp assigns because: (a) the buyer is in distress and choosing is a burden they cannot carry; (b) therapists are functionally unevaluable from a profile — a novice cannot tell a good one from a bad one by reading a bio; (c) fit is genuinely unknowable until you try; (d) there is stigma, so scrolling a wall of faces feels exposing.

Which of these transfer to tutoring?

| BetterHelp reason | Transfers? | Why |
|---|---|---|
| Buyer is overwhelmed, choosing is painful | **Partly** | A parent at 9pm is stressed and time-poor, but not incapacitated. Choosing a tutor is mildly *pleasant* — it is aspirational ("a Cambridge maths grad!"), not shameful. |
| Providers are unevaluable from a profile | **No** | Tutoring need is legible: *AP Calc BC, exam May 5, currently a C+, Tuesdays after 5*. Subject, level, exam board, language and schedule are objective filters. A parent can meaningfully read "8 years teaching IB HL Maths." |
| Fit is unknowable until you try | **Yes** | The strongest transferable reason. Rapport with a 14-year-old is not predictable from a CV. This is the real argument for assignment. |
| Stigma makes browsing uncomfortable | **No** | Inverted, in fact — showing the tutor is a *selling* moment. |

Two reasons survive at full strength, two do not. That is exactly why the answer is a hybrid and not a copy.

### 2.2 The argument against pure marketplace (from the user's experience)

1. **Choosing 1 of 40 is work the user did not sign up for.** The parent must invent evaluation criteria she does not have. She proxies on price and star rating, both of which are noisy. She takes 40 minutes, books someone, and never feels confident she chose well — so the first session carries the burden of justifying her choice rather than just being a good session.
2. **It exports our hardest problem to the least-equipped person.** We know which tutor has a free Tuesday slot, which one is good with anxious kids, who over-runs, who has a 92% rebooking rate. She knows none of it. Making her choose is a *worse* outcome dressed up as freedom.
3. **It destroys the emotional payoff.** "We found your tutor" is a gift. "Here are 40 tutors" is a task. The former is the reason a stranger trusts us enough to hand over a card.
4. **Supply collapses.** In an open marketplace the top decile takes most bookings; everyone else sits at zero, churns, and takes their best students off-platform. Assignment lets us load-balance — which is the same as saying *we can keep good tutors who are not yet famous*. (Supporting argument, not the lead one, per brief — but it is the one that actually kills companies.)
5. **It is incompatible with the subscription.** You cannot sell one monthly price for "the marketplace" when tutors charge €25 and €90. Marketplace ⇒ per-session or credits. Assignment and subscription are load-bearing for each other.

### 2.3 The argument against pure assignment — and the fix

1. **You are putting a stranger in a room with my child and not letting me see who.** This is where the therapy analogy breaks hardest. Opacity that reads as *discretion* in therapy reads as *concealment* in child safeguarding. Non-negotiable: full tutor identity, credentials and face, up front, before payment.
2. **Parents need to feel they exercised judgment.** Not to *do* the work — to *ratify* it. A parent who was handed exactly one option and no alternative feels processed. A parent who saw three, glanced at two, and confirmed the first feels like she chose. Same outcome, completely different relationship to it. This is the conversion mechanic.
3. **The 15–18 student has taste and will exercise it.** Denying them any say guarantees passive resistance in session one.

**The fix — "curated match with a visible bench":**

- The reveal is **one tutor**, full-bleed, hero-sized, named, with a 60-second intro video and an explicit *"Why we matched you"* list that quotes the user's own intake answers back at them.
- Below the fold: **exactly two** alternates, as small cards. Labelled *"Also strong fits"* — not "other options", which implies the first was arbitrary.
- The two alternates are genuinely good, genuinely available, and genuinely different from each other (e.g. one warmer/patient, one more exam-drill focused). Two is deliberate: enough to prove we are not hiding anything, few enough to not become a shopping trip. Three is already a grid.
- Switching to an alternate is one tap and costs nothing, ever.
- There is **no browse-all view, no search, no filters.** If someone rejects all three, they go back through a short re-match ("what was wrong?") rather than into a catalogue.

### 2.4 What changes if the founder picks marketplace instead

Pricing moves to credits or per-session packages; `/match` is replaced by `/browse` with faceted filters (subject, price, availability, rating, language) and `/tutors/[slug]` public SEO profiles — which, to be fair, is a real organic-acquisition advantage we forgo under assignment. Public reviews and star ratings become mandatory (§8.2 reverses). The tutor dashboard grows profile-optimisation and ranking-visibility tooling, and tutors start competing on price. The subscription differentiator disappears and we are in a commodity price war. I do not recommend it, but the SEO argument is the one honest point in its favour, and §11 D7 offers a way to get some of it back.

---

## 3. The student / parent journey, end to end

### 3.1 How much intake friction is worth it?

**Rule: never ask a question whose answer does not visibly change the match or the first session.** If we cannot point at where an answer is used, it is a survey, not intake.

BetterHelp asks ~20 questions over ~7 minutes before showing anything. They get away with it because their traffic is high-intent paid search from someone in crisis who is not comparison-shopping. Our traffic is warmer but *shoppier* — a parent with three tabs open. So:

**Two-stage intake, with the value reveal at ~90 seconds.**

- **Stage 1 — 6 questions, ~90 seconds, no account, no email, no card.** Ends in the match reveal.
- **Account wall** sits *between the reveal and the booking*, not before the reveal. Email + password (or Google), nothing more. The user has already seen Maria's face; giving an email to book her is a trivially easy ask. Putting the wall before the reveal costs, in my estimate, a third of the funnel.
- **Stage 2 — the deep profile, 3–4 minutes, after booking, skippable and resumable.** This is where the genuinely useful but unglamorous stuff lives: curriculum detail, accommodations, past tutoring history, materials upload. It is framed not as paperwork but as *"help Maria prepare for Thursday"* — because that is true, and because the reward is concrete and 48 hours away.
- **Card at booking.** First session is the trial (see D9).

**Progressive payoff inside stage 1.** Under each answered question, a small live counter: *"9 tutors match · Tue/Thu after 5pm"* → *"4 tutors match"*. It turns friction into visible narrowing and it sets up the reveal as the end of a process rather than a random assignment.

### 3.2 Stage 1 — the six questions (actual copy)

Route: `/start`, one question per screen on mobile, two per screen ≥768px. Large tap targets, no free text, back always available, progress dots. No question requires typing except Q5's optional note.

**Q1 — Who is this for?**
`[ My child ]  [ Myself ]`
→ Branches the entire flow. "My child" sets household mode, safeguarding on, and changes pronouns throughout.

**Q2 — What year/grade is {they / are you} in?**
Segmented picker: `Grade 6 · 7 · 8 · 9 · 10 · 11 · 12 · University · Adult learner`
(Locale-aware labels — Year 7–13 in UK. Drives level-matching and session length defaults.)

**Q3 — What subject do you need help with?**
Grid of large tappable cards, most-common-first: `Maths · Physics · Chemistry · Biology · English · Computer Science · Spanish · French · Other`
Selecting Maths reveals an inline sub-picker: `Algebra I · Algebra II · Geometry · Pre-Calc · Calculus (AP/IB) · Statistics · General / not sure`
`General / not sure` is a first-class answer, not a failure state — many parents genuinely do not know, and forcing precision here loses them.

**Q4 — What are we aiming for?** (single select, this becomes the Goal object that drives §6 entirely)
- `Catch up — {they're} falling behind`
- `Keep up — steady support through the year`
- `Push ahead — {they're} doing fine and want more`
- `A specific exam` → reveals: which exam + date picker *"When is it?"*
- `Confidence — {they} dread this subject`

**Q5 — Anything we should know?** (optional, 1 short free-text field, 200 chars, placeholder: *"e.g. she has an IEP for extra time, or he's had a rough year with his teacher"*)
The only free text in stage 1. High-value: this is what the matching operator actually reads, and quoting a fragment of it back in "Why we matched you" is the single most trust-generating move in the funnel.

**Q6 — When could you meet, most weeks?**
A coarse grid — days × three dayparts (before school / afternoon / evening), tap to toggle. **Not a calendar.** Nobody knows their exact availability for the next 12 weeks, and asking for it here is the classic intake-killer. Plus a timezone, prefilled from the browser and confirmable.

→ `[ Find my tutor ]`

That is it. Six screens, no typing required, ~90 seconds honest.

### 3.3 The matching moment

This is the emotional centrepiece. Three beats.

**Beat 1 — the work being done (3–5 seconds, and honest).** Not a fake 30-second progress bar; users have learned to read those as theatre and it cheapens what follows. A short, real, narrated sequence with the user's actual criteria echoed:

```
   Checking 340 tutors in your timezone…      ✓
   47 teach AP Calculus BC                    ✓
   12 are free Tuesday and Thursday evenings  ✓
   Ranking by fit with what you told us…      ●
```

Cap it at 5s. If the backend is slower, hold on the last line — never leave the screen before the data is real, and never fake completion.

**Beat 2 — the reveal.** Full-bleed, single tutor, one screen. See wireframe §7.2. The load-bearing elements, in priority order:

1. **A real photograph, large, human, looking at camera.** Not a corporate headshot grid cell.
2. **"We found your tutor" / "Meet Maria."** Named, full first name + last initial.
3. **A 45–90s intro video**, autoplaying muted with captions on, tap to unmute. This is the highest-conversion asset on the site and the single biggest ask we make of tutors in §4. It answers "would my kid like this person" in a way no bio ever will.
4. **"Why we matched you" — exactly 3 bullets, each tied to a specific intake answer,** e.g. *"You said Emma dreads maths — Maria specialises in rebuilding confidence after a bad year"*, *"Teaches the exact AP Calc BC syllabus, 6 years"*, *"Free Tuesdays and Thursdays at 5:30pm, your two best slots."* Written per-match from real fields, not generic marketing lines. If we cannot generate three honest ones, show two.
5. **Credentials with verified badges**, inline, not on a sub-page: degree + institution, years teaching, background check date, ID verified.
6. **Primary CTA: the first actual slot.** `[ Book Thursday, 5:30pm ]` — a specific time, not "Book a session". Specificity collapses the decision.
7. Secondary: `See 2 other strong fits ↓`. Tertiary, small: `Not quite right?`

**Beat 3 — the bench.** Scrolling past the hero reveals the two alternates as compact cards with photo, name, one-line credential, one-line differentiator, and `[ Choose {name} instead ]`. Swapping is instant, free, silent, and does not require a reason.

`Not quite right?` opens a 3-option sheet — *wrong subject focus · schedule doesn't work · I'd prefer someone different* — and re-runs the match with that constraint. After two re-matches, route to a human: *"Let's get this right — book 10 minutes with our team."*

### 3.4 Account creation → first session booked

1. Tapping the slot opens the booking sheet: date/time in the user's timezone with the tutor's timezone shown in grey beneath, duration, recurrence (`Just this once` / `Weekly at this time` — default **weekly**, because retention is a scheduling artifact more than a satisfaction artifact).
2. **Account wall.** Email + password or Google. One screen. If "My child" was selected: `Parent/guardian email` explicitly labelled, with a line of copy — *"You'll manage billing and see progress. Emma gets her own login next."*
3. **Plan + card.** Plan selection is deliberately simple (see D2) — show it as a single recommended plan with one cheaper and one bigger option, not a 4-column pricing matrix. First-session guarantee stated *on this screen*, at the point of fear: *"If the first session isn't right, we'll rematch you and refund it. No call required."*
4. **Confirmation screen — this is an onboarding screen disguised as a receipt.** Three next actions:
   - `[ Invite Emma ]` → sends the student their own login link (SMS or email). **The single most important post-purchase action**; a household where the student never logs in churns at a much higher rate because the async channel never activates.
   - `[ Tell Maria about Emma ]` → stage 2 intake.
   - `[ Add to calendar ]` → .ics + Google/Outlook one-tap.
5. Calendar invite, email confirmation, SMS confirmation to the parent. Student gets a separate, friendlier message.

### 3.5 Stage 2 — the deep profile ("Help Maria prepare")

Framed as helping, not form-filling. Progress bar, ~8 items, each skippable, resumable from the dashboard with a persistent nudge card.

- **Current standing.** Last grade/score in this subject (picker, not free text) + optional photo upload of a recent test or report card. *The photo upload is the highest-signal, lowest-effort item we have — a parent photographing a marked test with her phone gives the tutor more than ten questions would.* Put it early.
- **Curriculum & board.** School, textbook, exam board (AQA/Edexcel/OCR/IB/AP/College Board/state standards). Prefilled where inferable from the school.
- **Specific trouble spots.** Multi-select of topics in that subject, plus "not sure — that's what I need you to find out."
- **How {they} learn best.** 4 illustrated options: *worked examples · talking it through · practice drills · visual diagrams*. Coarse and slightly unscientific, but it gives the tutor a starting posture and it makes the parent feel seen.
- **Accommodations.** IEP/504/EHCP, extra time, dyslexia, ADHD, anxiety, hearing/vision, other. Explicitly and visibly optional, with a clear statement of who sees it (the tutor, and no one else). This must be handled with care — it is the most sensitive data we hold and a careless UI here is a trust catastrophe.
- **Homework & materials.** "Can Maria set work between sessions?" `Yes / light only / no`. Sets expectations both ways.
- **Student's own voice** (if 13+, in the student's own onboarding, not the parent's): *"What's the most annoying thing about this subject?"* — one free text field. Tutors report this as the best thing they read before a first session.
- **Parent's definition of success.** *"In three months, what would make you say this worked?"* Free text. Resurfaced verbatim in the first monthly progress report (§6.3) — a small, cheap, disproportionately powerful loop.

### 3.6 First session held

- **T-24h:** reminder (parent + student), plus tutor's prep note: *"Maria's planning to start with quadratics — she's seen Emma's last test."* Proof the intake was read.
- **T-15m:** push/SMS with a join link. Room opens at T-10m.
- **Session room:** §5.
- **T+0 to T+10m after:** tutor completes the post-session ritual (§4.6) — 20 seconds, 3 taps.
- **T+15m:** parent receives the **first session summary** — what was covered, tutor's plain-language read, homework set, next session time. This email is the moment the parent decides whether she bought something real. It should be the best-crafted email in the product.
- **T+2h:** student gets a light check-in — a single thumbs up/down and an optional one-liner. Feeds matching quality, never shown publicly.
- **T+24h (first session only):** parent gets *"How did it go?"* with a visible, non-punitive `Something felt off →` link that leads straight to rematch, not to a support queue. Making the exit easy at the moment of doubt is what makes the guarantee credible.

### 3.7 The ongoing relationship — the between-sessions loop

This is what the subscription actually buys and it must feel continuous, not transactional. The weekly rhythm:

```
 Session (Tue 5:30)  →  Tutor sets homework in-room  →  Student works
        ↑                                                     ↓
 Tutor reviews, annotates,  ←  Student photographs it  ←  Gets stuck, messages
 replies by next morning        from their phone           Maria at 11:40pm
```

- **Messaging is the primary channel** — BetterHelp's core insight, fully transferable. Tutor SLA: reply by **next weekday morning**; messages sent before 9pm on a school night get a same-evening best-effort. SLA is shown to the tutor as a soft countdown (§4.5), never as a public promise we cannot keep.
- **Photo-of-worksheet upload is the killer input.** Camera-first on mobile, multi-page, auto-deskew. The student photographs question 7, circles the bit they are stuck on with a finger, sends. Tutor annotates the same image and replies. This one interaction is worth more than any feature on the roadmap.
- **Homework objects, not chat mentions.** Assigned work has a due date, a state (`assigned / submitted / reviewed`), and appears on both dashboards. Quietly, this is also the most honest engagement metric we have for the parent.
- **Rescheduling must be genuinely easy** — one tap from the reminder, drag on the schedule, tutor's open slots shown inline. The #1 cause of churn in tutoring is a missed session that never gets rebooked. Any session cancelled >12h out auto-prompts a reschedule *in the same interaction*; never let a cancellation end as a cancellation.
- **Session cadence health:** if two consecutive weeks have no session, the parent gets a gentle, non-guilt-tripping nudge with a one-tap rebook. If three, ops is alerted — that household is lost within the month otherwise.

### 3.8 Switching tutors

The BetterHelp one-tap switch is a **feature we should market, not bury.** Its entire value is pre-purchase: it removes the fear of picking wrong, which is the fear blocking the card. It must therefore be visible before it is needed.

- Entry points: tutor profile card (`Change tutor`), settings, every post-session check-in, the monthly report footer, and the help menu. Never more than two taps away.
- Flow: `Change tutor` → *"Help us do better — what wasn't working?"* (multi-select: scheduling · teaching style · communication · not enough progress · student didn't connect · other + optional text) → **immediately show 2 new candidates chosen to address the stated reason** (do not make them wait for a re-match email) → pick → new tutor introduced, existing homework and progress map carried over → old tutor notified with a neutral, non-blaming template.
- **Continuity is the design problem here.** A switch must not feel like starting over. The new tutor inherits the goal, the skill map, the materials and a handover note. The parent sees one continuous progress timeline with a small marker on it: *"Tutor changed — Maria → David."*
- No limit, no fee, no guilt copy. If someone switches three times, that is a matching failure and it goes to ops, not to a friction wall.

### 3.9 Cancellation

Cancellation UX is trust UX. A product that hides the cancel button is telling every prospective buyer something about itself, and parents talk.

- `/app/billing/cancel` reachable in **two taps from the dashboard**. No phone call. No "chat with an advisor."
- The flow may offer alternatives — once, honestly, not as a maze:
  1. *"Taking a break? Pause for up to 3 months and keep Maria."* — **Pause is the highest-value save and the most user-respecting**, and it matches the real seasonality of tutoring (summer, post-exam). Keeps the tutor relationship, which is the hard-won asset.
  2. *"Switch tutors instead?"* — only shown if the cancel reason indicates fit.
  3. *"Fewer sessions a month?"* — downgrade path.
- Then: the actual cancel button, same visual weight as the alternatives. Confirm what happens: access until period end, sessions already booked honoured, data retained 12 months, progress report downloadable.
- **Exit survey after the cancel is confirmed, never before.** One question, optional.
- Offer a PDF export of the progress record on the way out. It costs us nothing, it is genuinely useful to them for a new tutor or a school meeting, and it is the reason they come back in September.

---

## 4. The tutor journey (supply-side, first-class)

The governing metric for this whole section is **time-to-first-paid-session**. Target: **under 10 days** from application submitted. Every week beyond that loses a meaningful share of the cohort to a competitor or to giving up. The second metric is **weeks-to-full-schedule**; a tutor who sits at one student for a month is gone.

### 4.1 Application

Funnel entry `/become-a-tutor` — a real landing page that answers, above the fold: *what will I earn, how many hours, when do I get my first student*. Not "join our community of passionate educators." Show a concrete number and a concrete timeline.

`/tutor/apply` — **split into two sittings on purpose.**

**Sitting 1 (~8 minutes, gets them in the pipeline):**
1. Name, email, phone, country/timezone, right to work.
2. Subjects + levels they can teach — the same taxonomy students choose from, so matching is exact. Cap at 4 subjects; "I can teach anything" is a red flag and a bad experience.
3. Experience: years, setting (school / private / university / none), qualifications.
4. Availability sketch — the same coarse day × daypart grid students use.
5. `Why do you tutor?` — 150 words. Human filter; also raw material for their profile bio later.
6. Submit. **Immediate on-screen answer with a real timeline:** *"You're in. Next: a 20-minute screening call — book it now."* with a live calendar. Do not send them away to wait for an email.

**Sitting 2 (documents, ~15 min, can be done from a phone):** ID upload, degree certificate, teaching qualification, proof of address, background check consent (DBS / state check / local equivalent — jurisdiction-dependent, see D6).

### 4.2 Vetting — the status tracker is the product here

**The number one supply-side failure is silence during vetting.** A good tutor who applies and hears nothing for nine days is a good tutor who is now on Wyzant. `/tutor/apply/status` is therefore a real, designed, frequently-emailed screen — a vertical tracker with **an ETA on every stage** and a named next action:

```
 ✓ Application received              Sep 12
 ✓ Screening call                    Sep 15 · passed
 ✓ ID & qualifications verified      Sep 16
 ● Background check                  in progress · usually 3–5 days
   └ Started Sep 16 · we'll email you the moment it clears
 ○ Build your profile                you can do this now →   [ Start ]
 ○ First student                     usually within 5 days of approval
```

Note that profile building is **unlocked in parallel** with the background check, not after it. It shortens time-to-first-student by days and it gives the waiting tutor something to do, which is its own retention mechanic.

**The screening call** (20 min, video, with an ops person): 5 min background, **10 min live teaching task** — "explain why dividing by a fraction flips it, to a 13-year-old who thinks they're bad at maths" — 5 min logistics and platform walkthrough. The teaching task is the whole point; a CV does not predict whether someone can explain.

### 4.3 Profile building — guided, not a blank box

Blank-textarea profile builders produce bad profiles, which produce bad match reveals, which lose students. So: guided prompts, a live preview of exactly how the student's match card will look, and a completeness meter tied to something the tutor cares about (*"Profiles with an intro video get matched 3× more often"* — state the real number once we have it, not before).

- **Photo.** In-browser capture or upload, with concrete guidance: face visible, plain background, look at the camera, smile. Reject sunglasses/group photos automatically.
- **Intro video, 45–90s, recorded in-browser.** The single biggest ask and the single biggest conversion lever. Give a teleprompter with a 4-beat script — *who you are · what you teach · how you teach it · one sentence to the student, not the parent*. Allow unlimited retakes. Show examples from strong tutors. Do not let this be a file-upload-only affair; friction here kills completion.
- **Bio** via three short prompts rather than one big box: *"What's your approach with a student who's fallen behind?"*, *"What do students say about you?"*, *"Something human about you."*
- **Specialisms & differentiators** — structured tags that feed the matching engine and the "Why we matched you" bullets: exam boards, accommodations experience (ADHD, dyslexia, anxiety), age comfort ranges, languages.
- **Credential display consent** — the tutor confirms what is shown publicly (§8.1).

### 4.4 Availability

The most-used tutor screen after Messages, and the one most often designed badly.

- **Weekly recurring template** as the base (`Tue 16:00–20:00`), because that is how real availability works — not a per-date calendar, which no one maintains.
- **Exceptions layer** on top: block a date, add a one-off slot, a date-range holiday.
- **Timezone-correct always**, with DST handled visibly. A tutor in London with students in Boston needs to see both; show the tutor's own timezone as primary and a secondary overlay for any student outside it.
- **Capacity, not just time:** `Max students: 8` and an `At capacity` toggle. Critically — **declining a match must never be punished.** Give them an honest lever to say "full", or they will decline offers and feel guilty, then take fewer, then leave.
- **Buffer rules:** minimum notice for new bookings (default 12h), gap between sessions (default 15 min), max sessions per day.
- Calendar sync is two-way with Google/Outlook: busy events block slots automatically. This is a genuine retention feature for tutors and a real engineering ask (§10).

### 4.5 Accepting students

- New matches arrive as a **Match Offer** card in `/tutor/requests`, push + email + SMS, with an accept window (**24 hours**, visibly counting down — after which it rolls to the next tutor, which is the load-balancing mechanism in practice).
- The offer shows enough to make a real decision: grade, subject, goal, the parent's "anything we should know", requested days/times, session cadence, and estimated monthly earnings from this student. **Show the money.** A match offer without an earnings figure is asking someone to accept an unpriced obligation.
- `[ Accept ]` / `[ Decline — schedule ]` / `[ Decline — not my subject ]`. Structured decline reasons improve matching far more than a free-text box.
- On accept: an intro message is pre-drafted (editable, never auto-sent — auto-sent intros read as bot and poison the first impression), the student's profile and uploaded materials unlock, and the first session slot is proposed.

### 4.6 Running a session — and the 20-second post-session ritual

The session room is shared with the student (§5) with tutor-only controls: homework assignment, the skill map, private notes, session extend, and end-session.

**The post-session ritual is the most important 20 seconds in the entire product**, because it is the only mechanism by which progress data (§6) ever gets collected. If it takes more than 20 seconds it will not get done, and the parent dashboard will be empty, and the subscription will not renew. It auto-opens the instant the call ends, and it is three taps:

```
 ┌──────────────────────────────────────────────┐
 │  Session complete · Emma · Algebra II · 52m   │
 │                                              │
 │  Topics covered — tap to set mastery         │
 │   Quadratic formula     [○ shaky ●solid  ]   │
 │   Completing square     [●shaky  ○ solid ]   │
 │   + add topic                                │
 │                                              │
 │  How did it go?      😕   😐   🙂   ⭐        │
 │                                              │
 │  Note for Emma's parent (optional)           │
 │  [ Emma got the formula today — the sign    ]│
 │  [ errors are nearly gone.                  ]│
 │                                              │
 │  Homework:  [ ✓ set in session ]             │
 │                                              │
 │            [ Done — send summary ]           │
 └──────────────────────────────────────────────┘
```

Topics are pre-populated from what was opened on the whiteboard and from the syllabus map, so the common case is two taps. The parent note is optional but heavily nudged — offer a one-tap AI draft generated from the session (tutor edits and approves; **never send an unreviewed generated note to a parent**).

### 4.7 Getting paid

- **Weekly payouts, fixed day (Friday), stated everywhere.** Predictability beats speed. A tutor who cannot predict Friday's number will not treat this as a real job.
- `/tutor/earnings`: this week, next payout date and amount, month to date, per-student breakdown, and a clear line between session earnings and async/messaging compensation.
- **Async work must be paid.** If messaging is the primary channel (§3.7) and it is unpaid, tutors will quietly stop replying and the core differentiator dies within a quarter. See D3 — my recommendation is a **monthly per-student retainer** covering async plus a per-session rate, which aligns the tutor with the subscription rather than against it.
- **No-show policy, visible before it is needed:** student no-show after 15 min = tutor paid in full, one-tap to mark. Cancellations inside 12h = paid at 50%. Publish this on `/become-a-tutor`; it is a recruiting advantage.
- Tax documents, payout method (Stripe Connect), invoice history, and a self-serve way to fix a wrong payout without emailing support.

---

## 5. The session experience

Tutoring is not therapy: therapy needs a face and a voice; tutoring needs a **shared surface with a problem on it**. The room is therefore document-and-canvas-first, with video as a supporting element — the opposite of a video-conferencing layout.

### 5.1 The room, and what is in it

- **Video:** small, persistent tiles, movable, collapsible to audio-only. Never the centre of the screen. A student staring at their own face is a student not doing maths.
- **The shared canvas** is the centre: infinite whiteboard with pen, shapes, text, **an equation editor**, graphing (plot `y = x² - 4x + 3` and manipulate it), and — for CS — a runnable code pane. Both parties draw. Handwriting input with a stylus on tablet is the ideal case and should be first-class.
- **Document pane:** open the uploaded worksheet/PDF/photo *as a canvas layer* and annotate directly on it. This is the actual core loop of tutoring — "let's look at question 7 together" — and it must be two clicks, not a screen-share-and-squint.
- **Screen share:** for the student to show their homework platform, their IDE, or a school portal. Needed, but secondary to the canvas.
- **Chat:** for links, quick text, and anything spoken that needs to persist.
- **Materials tray:** everything the student uploaded plus everything the tutor has prepared, one click away.
- **Recording:** on by default for under-18 (see §8.3 and D5), with a persistent, unmissable indicator for both parties.
- **Session timer** with a 5-minutes-remaining cue and a tutor-side `Extend 15 min` (billing implications per D2).

### 5.2 After the bell

Everything created in the room persists to `/app/sessions/[id]`: the canvas as a scrollable/downloadable artefact, the annotated worksheet, the chat transcript, the recording (per policy), the homework set, and the tutor's summary. **A session must leave a durable object behind.** A tutoring session that vanishes when the call ends is worth a fraction of one that leaves a page the student can revisit the night before the test — and it is the difference between a subscription and a series of purchases.

### 5.3 Mobile reality — state it plainly

A collaborative whiteboard on a 390px phone screen is a bad experience and we should not pretend otherwise. Position:

- **Desktop/tablet is the recommended session device**, and we say so — in the booking confirmation, the T-24h reminder, and a device check at T-10m.
- **Mobile is a functional fallback, not a full room:** video + chat + *view-only* canvas + the ability to photograph and send work. Enough to not lose the session when someone is in a car, not sold as equivalent.
- **Everything else in the product is mobile-first and mobile-complete:** intake, the match reveal, messaging, homework photo upload, rescheduling, progress, billing. The session room is the single deliberate exception.
- **Pre-session device & permission check** at T-10m: camera, mic, network. Catching a broken mic before a paid session starts is worth a whole support tier.

---

## 6. Progress and outcomes — the retention mechanic

Therapy cannot prove it works. Tutoring can, and if we do not build this we are just a video-call scheduler with a subscription attached. **This is the section that makes the renewal happen.**

### 6.1 The spine: Goal → Skill Map → Evidence

**The Goal** is set at intake (Q4) and restated in the parent's own words in stage 2. Everything in the progress surface answers *"are we closer to this?"* — not "how much have you used the product?"

**The Skill Map** is a syllabus decomposed into 20–60 topics per subject/level, each in one of four states: `not started · shaky · getting there · solid`. The tutor moves them in the 20-second post-session ritual (§4.6). This is the core dataset and it exists only because that ritual is short.

Rendered for the student as a progress map they can actually feel — grouped by unit, coloured by state, with a plain count at the top: *"14 of 32 topics solid."* Rendered for the parent as a trend, not a grid.

**Evidence** is split into two clearly-labelled tiers, and the honesty of this split is the entire trust proposition:

| Tier | Examples | Label |
|---|---|---|
| **Verified by us** | Sessions attended, homework set/completed, topics moved to solid, tutor assessments, in-app quiz scores | Shown plainly |
| **Reported by you** | School grades, test and exam scores, teacher feedback | Marked *"you told us"* |

**Never present reported outcomes as platform-verified, and never compute a fake improvement percentage.** A dashboard claiming "Emma improved 23%" is both unfalsifiable and insulting to a parent who can see her kid's actual report card. Honest data, well presented, is more persuasive — and it survives the conversation the parent has with her spouse.

### 6.2 Getting outcome data in

The hard part is not display, it is collection. Three low-friction hooks:

1. **"Got a test back?"** — a card that appears on the student's dashboard 2–3 days after any session where a test was mentioned. Photograph it, enter the score, done. The photo also becomes material for the next session, so the ask has an immediate selfish payoff for the student.
2. **Monthly one-tap check from the parent:** *"How's Emma doing in Algebra II at school?"* → `Better · Same · Worse` + optional grade. Ten seconds, in the monthly email, no login required (signed link).
3. **Baseline diagnostic, optional, session one.** A 15-minute in-room assessment the tutor runs. Gives a real starting point and makes every later comparison meaningful. Opt-in — for a confidence-crisis student, a test in session one is exactly wrong.

### 6.3 The monthly progress report — the renewal artefact

Email-first (the parent lives in email), with a web version at `/app/progress`. Sent the day before the billing date — deliberately. This is what she is renewing *against*.

```
 ┌──────────────────────────────────────────────────────────┐
 │  Emma · Algebra II · September                           │
 │                                                          │
 │  In August you said: "I want her to stop dreading        │
 │  maths homework."                                        │
 │                                                          │
 │  ▸ 4 of 4 sessions attended                              │
 │  ▸ 7 topics moved to solid  (was 3)                      │
 │  ▸ 6 of 7 homework sets completed                        │
 │  ▸ You reported: quiz score up C+ → B                    │
 │                                                          │
 │  ── Topic mastery ──────────────────────────             │
 │   Sep 1   ███░░░░░░░  3 solid                            │
 │   Sep 30  ███████░░░  7 solid                            │
 │                                                          │
 │  From Maria:                                             │
 │   "Emma's sign errors have almost disappeared. She       │
 │    asked me a question unprompted this week, which       │
 │    she'd never done. Next month: word problems."         │
 │                                                          │
 │  Next month's focus: quadratic word problems, then       │
 │  a mock unit test in week 3.                             │
 │                                                          │
 │  [ See full progress ]   [ Message Maria ]               │
 └──────────────────────────────────────────────────────────┘
```

Four properties make this work: it **quotes her own stated goal back**, it **separates verified from reported**, it carries **one paragraph of real human voice** (the thing no dashboard can fake), and it **states next month's plan** — giving her a reason for next month to exist. The forward-looking line is the actual renewal mechanism.

### 6.4 Student-facing motivation — carefully

The student needs a different reward than the parent. Keep it light and avoid the gamification trap (points and streaks aimed at teenagers read as condescending and collapse within weeks):

- The topic map filling in — visible, tactile, the primary reward.
- A short note from the tutor after each session ("that was a good question today"). Low-tech, high-impact.
- **Streaks and badges: no.** Session attendance is controlled by the parent's wallet and the calendar, so a broken streak punishes the student for something they do not control.
- One genuinely good moment: when a unit goes fully solid, a small, well-made celebration. Once per unit, not once per session.

---

## 7. Screen inventory & information architecture

Three top-level surfaces, deliberately separated by route prefix — different users, different navigation, different mental models. Do not try to unify the tutor and student apps into one shell; they diverge almost completely.

```
  /                public / marketing / SEO
  /start · /match  the funnel   (own minimal chrome, no app nav)
  /app             household surface  (parent + student, role-aware)
  /tutor           tutor surface
  /admin           internal ops
```

### 7.1 Route list

**Public & marketing** — Next.js static/ISR, SEO-relevant
| Route | Purpose |
|---|---|
| `/` | Landing. One promise, the match guarantee, a real tutor's face. Primary CTA → `/start` |
| `/how-it-works` | The 4 steps. Addresses "will I get to choose?" head-on |
| `/pricing` | Plans, what's included (async!), guarantee, cancel-anytime |
| `/subjects/[subject]` | SEO landing per subject/level. The main organic acquisition asset under an assigned-match model |
| `/for-parents` | Safeguarding, vetting, what you see, what you control |
| `/trust-and-safety` | Vetting standard, background checks, recording policy, reporting |
| `/become-a-tutor` | Supply landing: earnings, hours, timeline to first student |
| `/legal/*` | Terms, privacy, child data policy, refunds |

**Funnel** — minimal chrome, no nav, exit-intent aware
| Route | Purpose |
|---|---|
| `/start` | Stage-1 intake shell |
| `/start/[step]` | Q1–Q6 (§3.2). URL-addressable so progress survives a refresh |
| `/match/searching` | The 3–5s narrated matching beat |
| `/match` | **The reveal.** Hero tutor + 2 alternates |
| `/match/[tutorId]` | Expanded tutor detail (video, full bio, credentials) |
| `/match/rematch` | "Not quite right" reason capture → re-run |
| `/book/[tutorId]` | Slot selection + recurrence |
| `/signup` · `/login` · `/verify` · `/reset` | Auth |
| `/checkout` | Plan + card + guarantee restated |
| `/welcome` | Confirmation-as-onboarding: invite student, deep profile, add to calendar |
| `/invite/[token]` | Student accepts their invite, sets password, does their short intake |

**Household app `/app`** — role-aware; parent and student see different dashboards at the same route
| Route | Purpose |
|---|---|
| `/app` | Dashboard. Parent view vs student view (§7.4, §7.5) |
| `/app/messages` · `/app/messages/[threadId]` | Async messaging, file/photo attach |
| `/app/schedule` | Upcoming + past sessions, book, reschedule, cancel |
| `/app/sessions/[id]` | Session detail: summary, canvas artefact, recording, homework, materials |
| `/app/room/[sessionId]` | **The live session room** |
| `/app/homework` · `/app/homework/[id]` | Assigned work, submit via photo, tutor feedback |
| `/app/progress` | Goal, skill map, trend, reports archive |
| `/app/progress/report/[month]` | A single monthly report, shareable/printable |
| `/app/tutor` | The assigned tutor's profile, message, change tutor |
| `/app/tutor/switch` | Switch flow: reason → 2 new candidates → confirm |
| `/app/learners` · `/app/learners/[id]` | Parent only. Multiple children, add a learner |
| `/app/materials` | Uploaded worksheets, past tests, tutor resources |
| `/app/billing` | Plan, invoices, payment method, pause |
| `/app/billing/cancel` | Cancellation (two taps from dashboard) |
| `/app/settings/*` | Profile, notifications, timezone, safeguarding controls, accessibility |
| `/app/help` · `/app/report` | Support; **report a concern** (always-visible, distinct from support) |

**Tutor app `/tutor`**
| Route | Purpose |
|---|---|
| `/tutor/apply/[step]` · `/tutor/apply/status` | Application + the vetting status tracker (§4.2) |
| `/tutor` | Today: next session, unanswered messages w/ SLA, pending offers |
| `/tutor/requests` | Match offers with countdown + estimated earnings |
| `/tutor/students` · `/tutor/students/[id]` | Roster; per-student goal, skill map, history, notes |
| `/tutor/messages` | Unified inbox across students, SLA-ordered |
| `/tutor/schedule` | Calendar view |
| `/tutor/availability` | Recurring template + exceptions + capacity |
| `/tutor/room/[sessionId]` | Session room, tutor controls |
| `/tutor/sessions/[id]/wrap` | The 20-second post-session ritual |
| `/tutor/earnings` | Payouts, breakdown, tax docs |
| `/tutor/profile` | Public profile editor w/ live match-card preview |
| `/tutor/resources` | Teaching materials library, platform training |

**Admin `/admin`** — V1, not V2
`/admin/matches` (match queue: proposed shortlist, operator confirms/overrides) · `/admin/applications` (vetting pipeline) · `/admin/reports` (safeguarding queue, recording access requests) · `/admin/households` · `/admin/billing` (refunds, comps) · `/admin/supply` (coverage gaps by subject × daypart — the ops screen that prevents the "no tutor available" dead end)

### 7.2 WIREFRAME — `/match` · the reveal (**the most important screen**)

Mobile (390px) on the left, the desktop arrangement noted after.

```
┌────────────────────────────────────────┐
│  ● ● ● ● ● ●  ✓                        │  progress, now complete
│                                        │
│        We found your tutor.            │  serif, large, calm
│                                        │
│  ┌──────────────────────────────────┐  │
│  │                                  │  │
│  │      [ INTRO VIDEO 45–90s ]      │  │  autoplay muted,
│  │       ▶ tap to unmute            │  │  captions on,
│  │                                  │  │  poster = her photo
│  │                            0:52  │  │
│  └──────────────────────────────────┘  │
│                                        │
│   Maria R.                             │  28px
│   MSc Mathematics, Imperial College    │
│   6 years teaching AP Calculus         │
│                                        │
│   ✓ ID verified   ✓ Background check   │  green check chips,
│   ✓ Degree verified      Aug 2026      │  tappable → detail
│                                        │
│  ── Why we matched you ─────────────   │
│                                        │
│   • You said Emma dreads maths after   │
│     a rough year. Maria specialises    │
│     in rebuilding confidence.          │
│   • She teaches the exact AP Calc BC   │
│     syllabus — 6 years, 40+ students.  │
│   • Free Tuesdays & Thursdays 5:30pm,  │
│     the two slots you picked.          │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │   Book Thursday, Sep 24 · 5:30pm │  │  PRIMARY. A real slot,
│  └──────────────────────────────────┘  │  not "Book a session"
│                                        │
│   First session is covered by our      │
│   match guarantee — if it's not right, │
│   we'll rematch and refund it.         │
│                                        │
│         See 2 other strong fits  ↓     │  secondary
│                                        │
│  ══════════════════════════════════    │
│                                        │
│   Also strong fits                     │
│  ┌────────────────┐ ┌────────────────┐ │
│  │ [photo]        │ │ [photo]        │ │
│  │ David K.       │ │ Priya S.       │ │
│  │ PhD Maths,     │ │ Former AP      │ │
│  │ 9 yrs          │ │ teacher, 12yrs │ │
│  │ "Exam-drill    │ │ "Patient, very │ │
│  │  focused"      │ │  structured"   │ │
│  │ Tue 6pm free   │ │ Thu 5pm free   │ │
│  │ [ Choose ]     │ │ [ Choose ]     │ │
│  └────────────────┘ └────────────────┘ │
│                                        │
│          Not quite right?  →           │  tertiary, small
└────────────────────────────────────────┘
```

Desktop ≥1024px: two columns — video + photo left, name/credentials/why/CTA right; alternates as a 2-card row below the fold. Keep the fold break so the scroll to alternates is still a deliberate act.

**Why this is the most important screen:** it is the only place where the entire product thesis is tested. If the reveal lands, the user's decision cost drops to zero and they book in one tap; if it does not, nothing downstream — the session room, the progress map, the subscription — ever happens. It is also the screen a marketplace structurally cannot have, so it is where the differentiation is either real or absent.

### 7.3 WIREFRAME — `/start/[step]` · an intake question

```
┌────────────────────────────────────────┐
│  ←                          ● ● ● ○ ○ ○│
│                                        │
│   What are we aiming for?              │  24px, one question
│                                        │  per screen on mobile
│  ┌──────────────────────────────────┐  │
│  │ 📉  Catch up                     │  │  large tap targets,
│  │     She's falling behind         │  │  ≥56px tall
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ 📚  Keep up                      │  │
│  │     Steady support this year     │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ 🚀  Push ahead                   │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ 🎯  A specific exam              │  │  ← expands inline:
│  │     ┌────────────────────────┐   │  │    which exam + date
│  │     │ AP Calculus BC       ▾ │   │  │
│  │     │ When?  [ May 5, 2027 ] │   │  │
│  │     └────────────────────────┘   │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ 💪  Confidence                   │  │
│  └──────────────────────────────────┘  │
│                                        │
│   ⓘ 12 tutors match so far             │  live narrowing —
│                                        │  friction made visible
│  ┌──────────────────────────────────┐  │
│  │            Continue              │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

### 7.4 WIREFRAME — `/app` · parent dashboard

The organising question is *"is this working, and is my child safe?"* — answered in the first 200px, before any scroll.

```
┌──────────────────────────────────────────────────────┐
│  TutorFinder     Emma ▾   Messages(1)   Billing   ⚙  │
├──────────────────────────────────────────────────────┤
│                                                      │
│   Emma is making steady progress in Algebra II.      │  ← ONE sentence.
│   7 topics mastered this month, 4 of 4 sessions.     │  Generated, plain,
│                                                      │  honest. The whole
│  ┌────────────────────────┐ ┌──────────────────────┐ │  dashboard's job.
│  │ NEXT SESSION           │ │ THIS MONTH           │ │
│  │ Thu Sep 24 · 5:30pm    │ │ Sessions    4 / 4  ✓ │ │
│  │ with Maria R.          │ │ Homework    6 / 7    │ │
│  │ [Reschedule] [Details] │ │ Topics solid  7 ↑4   │ │
│  └────────────────────────┘ └──────────────────────┘ │
│                                                      │
│  ── Progress toward your goal ──────────────────────  │
│   "I want her to stop dreading maths homework."      │  her own words
│                                                      │
│   Topics solid   ▁▂▃▅▆▇  3 → 7                       │
│   Reported grade C+ → B    (you told us, Sep 12)     │  tier label
│                          [ See full progress → ]     │
│                                                      │
│  ── Latest from Maria ──────────────────────────────  │
│   Sep 17 · "Emma's sign errors have almost           │
│   disappeared. She asked a question unprompted."     │
│                        [ Reply ]  [ All sessions ]   │
│                                                      │
│  ── Your tutor ─────────────────────────────────────  │
│   [photo] Maria R. · ✓ Verified · 6 yrs              │
│   Responds within ~4h        [ Message ] [ Change ]  │  ← switch is
│                                                      │    always visible
│  ── Safety ─────────────────────────────────────────  │
│   ✓ Background check current (Aug 2026)              │
│   ✓ Sessions recorded · [ Request access ]           │
│   ⚑ Report a concern                                 │
└──────────────────────────────────────────────────────┘
```

### 7.5 WIREFRAME — `/app` · student dashboard (mobile)

Different emotional job: *what do I have to do, and when.* No money, no "your parent is watching" framing, no progress-guilt.

```
┌────────────────────────────────────────┐
│  Hey Emma 👋                       ⚙   │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ NEXT · Thursday 5:30pm           │  │
│  │ with Maria · Algebra II          │  │
│  │ in 2 days                        │  │
│  │ [ Join ]  (opens 10 min before)  │  │
│  └──────────────────────────────────┘  │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ 📝 HOMEWORK · due Thursday       │  │
│  │ Quadratics worksheet, Q1–8       │  │
│  │ ┌────────────────────────────┐   │  │
│  │ │ 📷 Snap a photo when done  │   │  │  ← camera-first.
│  │ └────────────────────────────┘   │  │    The killer input.
│  └──────────────────────────────────┘  │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ 💬 Maria · 2h ago                │  │
│  │ "Nice work on Q4 — try Q5 with   │  │
│  │  the same trick"                 │  │
│  │ [ Reply ]                        │  │
│  └──────────────────────────────────┘  │
│                                        │
│  Your map                              │
│  Unit 3 · Quadratics                   │
│  ███████░░░  7 of 10 solid             │
│  ✓ Factoring   ✓ Formula   ~ Word probs│
│                     [ See all topics ] │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Got a test back? 📷 Add it       │  │  ← outcome capture,
│  └──────────────────────────────────┘  │    with a selfish payoff
│                                        │
│ ─────────────────────────────────────  │
│  🏠 Home  💬 Chat  📅 Sessions  📈 Map │  bottom tab bar
└────────────────────────────────────────┘
```

### 7.6 WIREFRAME — `/app/room/[sessionId]` · the session room (desktop)

```
┌──────────────────────────────────────────────────────────────────┐
│ ● REC   Algebra II · Emma & Maria            42:18 left    [End] │
├────────┬─────────────────────────────────────────────┬───────────┤
│        │                                             │  ┌──────┐ │
│ TOOLS  │        S H A R E D   C A N V A S            │  │Maria │ │
│        │                                             │  └──────┘ │
│  ✏ pen │    ┌───────────────────────────────┐        │  ┌──────┐ │
│  ⌫ era │    │ worksheet.pdf  p.2      [x]   │        │  │ Emma │ │
│  T txt │    │                               │        │  └──────┘ │
│  √ eqn │    │  7. Solve x² − 4x + 3 = 0     │        │   🎤 📹 ⛶ │
│  ∿ graf│    │                               │        │           │
│  ▣ shp │    │     ✍ (x−1)(x−3) = 0          │  ← both├───────────┤
│  </> co│    │        x = 1, x = 3  ✓        │    draw│ MATERIALS │
│        │    └───────────────────────────────┘        │ 📄 workshe│
│ ──────  │                                             │ 📷 last te│
│ PAGES  │    ✍ remember: sum = 4, product = 3         │ 📊 unit 3 │
│ [1][2] │                                             │ [+ add]   │
│ [3][+] │                                             ├───────────┤
│        │                                             │ CHAT      │
│ ──────  │                                             │ M: try Q8 │
│ 🖥 share│                                             │ E: ok!    │
│ 📄 open │                                             │ [type…]   │
├────────┴─────────────────────────────────────────────┴───────────┤
│ TUTOR ONLY:  [ Set homework ]  [ Skill map ]  [ Note ]  [ +15m ] │
└──────────────────────────────────────────────────────────────────┘
```

Mobile fallback: video + chat + view-only canvas + `📷 send a photo`. Stated as a fallback, not sold as the room.

### 7.7 WIREFRAME — `/app/messages/[threadId]` · async (the subscription's real value)

```
┌────────────────────────────────────────┐
│ ←  [photo] Maria R.        📅  ⓘ       │
│    usually replies within 4h           │  ← expectation set
├────────────────────────────────────────┤
│                                        │
│  ┌──────────────────────────────┐      │
│  │ Wed 11:42pm                  │      │
│  │ im stuck on q7 :(            │      │
│  │ ┌────────────────────────┐   │      │
│  │ │ [photo of worksheet,   │   │      │
│  │ │  q7 circled in finger] │   │      │
│  │ └────────────────────────┘   │      │
│  └──────────────────────────────┘ Emma │
│                                        │
│      ┌──────────────────────────────┐  │
│ Maria│ Thu 7:15am                   │  │
│      │ You factored right! Look at  │  │
│      │ your signs on the second     │  │
│      │ bracket 👇                   │  │
│      │ ┌────────────────────────┐   │  │
│      │ │ [same photo, annotated │   │  │  ← annotate the
│      │ │  in red by Maria]      │   │  │    student's own photo
│      │ └────────────────────────┘   │  │
│      └──────────────────────────────┘  │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ 📎  📷   Message Maria…      ➤   │  │
│  └──────────────────────────────────┘  │
│                                        │
│  ⓘ Keep messages on the platform —     │  safeguarding, stated
│    they're saved for Emma's safety.    │  plainly, not hidden
└────────────────────────────────────────┘
```

### 7.8 WIREFRAME — `/tutor` · today (supply-side home)

```
┌──────────────────────────────────────────────────────┐
│  Today · Thursday Sep 24        Earnings  Students ⚙ │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ⚠ 2 MESSAGES NEED A REPLY                           │  ← SLA first.
│  ┌────────────────────────────────────────────────┐  │    Nothing else
│  │ Emma R. · 11:42pm · "im stuck on q7"           │  │    outranks it.
│  │ ⏱ 7h 18m left to reply         [ Reply now ]   │  │
│  ├────────────────────────────────────────────────┤  │
│  │ Josh T. · 8:02am · photo attached              │  │
│  │ ⏱ 22h left                     [ Reply ]       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ── Today's sessions ───────────────────────────────  │
│   5:30pm  Emma R. · Algebra II · 60m                 │
│           Goal: confidence · HW: 6/7 done            │
│           [ Prep ]           [ Join at 5:20 ]        │
│   7:00pm  Josh T. · AP Calc · 60m                    │
│           [ Prep ]                                   │
│                                                      │
│  ── New match offer ────────────────────────────────  │
│  ┌────────────────────────────────────────────────┐  │
│  │ Grade 10 · Geometry · "catch up"               │  │
│  │ Tue/Thu evenings · ~€220/mo                    │  │  ← show the money
│  │ "He's lost confidence after a bad teacher"     │  │
│  │ ⏱ Expires in 19h                               │  │
│  │ [ Accept ]        [ Decline ▾ ]                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ── This week ──────────────────────────────────────  │
│   6 sessions · €340 · paid Friday                    │  ← predictable
│   Capacity: 6 of 8 students    [ At capacity ⃝ ]     │    payout day
└──────────────────────────────────────────────────────┘
```

---

## 8. Trust & safety UX

With minors involved, safeguarding is **visible design work**, not a backend policy with a link in the footer. The parent must be able to *see* the protections without asking, because the ones she cannot see she assumes do not exist.

### 8.1 Credential display

Verified badges must say **what was verified and when** — an unqualified "Verified ✓" is marketing and erodes exactly the trust it is trying to build.

```
  ✓ Identity verified            government ID · Aug 2026
  ✓ Background check             DBS Enhanced · Aug 2026 · renews Aug 2027
  ✓ MSc Mathematics              Imperial College London · certificate on file
  ✓ Teaching qualification       PGCE Secondary Maths · 2019
  ✓ 6 years teaching experience  self-reported, references checked
```

The last line is deliberately labelled `self-reported` — mixing verified and claimed facts under one badge style is the specific thing that makes a parent stop believing any of them. A `What we check →` link opens the full vetting standard.

Expiry is a first-class state: a lapsed background check shows an amber chip to ops and blocks new match offers automatically, before anyone has to notice.

### 8.2 Reviews — my position: **no public star ratings in V1**

This follows directly from assigned match. Public 5-star ratings exist to help buyers compare options; under assignment there is nothing to compare, so the ratings would be decoration that imports every marketplace pathology: rating inflation, tutors gaming for stars, tutors avoiding hard students to protect an average, and parents anchoring on 4.9-vs-4.8 noise.

Instead:
- **Private post-session feedback** (student thumbs + optional note, parent monthly pulse) that feeds matching quality and an ops quality score. A tutor's internal score drives match priority — which is a far stronger incentive than a public number, because it directly controls their income.
- **Selected, attributed testimonials** on the tutor's match card — *"3 of 4 parents this term said Maria improved their child's confidence"* — aggregate, honest, and not a leaderboard.
- **Tutors do see their own feedback**, framed as coaching with ops support, never as a public scoreboard.

*If the founder picks marketplace, this reverses entirely and public reviews become mandatory table stakes.*

### 8.3 Safeguarding for minors

In a 1:1 adult-with-child setting the usual control — a second adult in the room — is unavailable. **The recording is the control**, so it is not optional and it is not hidden.

- **All sessions with under-18 learners are recorded by default.** Neither the tutor nor the student can disable it. Both see a persistent, unmissable indicator. Parent sees "sessions are recorded" as a green line on her dashboard and can request access (logged, with the tutor notified — access is a right, not a secret surveillance channel). Recommend 90-day retention with legal hold on any report (D5).
- **All messaging is retained and reviewable.** Age-graded visibility, stated to everyone up front:
  - **Under 13:** parent has full read access to the student↔tutor thread. Shown in the thread header to all parties.
  - **13–17:** parent sees metadata (frequency, response times, attachments count) plus automated flags, **not verbatim content by default.** Full access on request through a logged safeguarding process. Rationale: a 15-year-old who knows every word is read by a parent will not use the channel, and the channel is the product. Both the student and the tutor see the visibility level in the header, so no one is deceived.
  - **18+:** private.
- **No contact-information exchange.** Phone numbers, emails and external handles are detected and blocked with an inline explanation rather than a silent strip — *"Keep it on the platform so sessions stay recorded and covered by the guarantee."* Repeated attempts flag to ops. This protects the student and, incidentally, prevents disintermediation.
- **No off-platform meetings.** Stated in tutor terms, in the student's first-session screen, and enforced by policy.
- **`⚑ Report a concern` is a persistent, always-reachable element** — session room, every message thread, tutor profile, dashboard footer. Distinct from "Help/Support" and visually distinct (not red-alarming, but unmistakable). The flow: what happened (categories: made me uncomfortable · inappropriate content · contact outside platform · safety concern · other) → free text → optional evidence → immediate acknowledgement with a real timeline and a human name. Serious categories page the on-call T&S operator and auto-suspend the tutor's new-match eligibility pending review.
- **Tutor-side safeguarding training** is a required module in onboarding, with an acknowledgement record.
- **Two-way identity confidence:** the student sees a "this is your verified tutor" marker in the room. Account sharing and impersonation are real risks; a visible identity anchor in the room is cheap insurance.

### 8.4 Guarantees and refunds

- **First-session guarantee**, stated at checkout, on the match reveal and in the confirmation email: *if the first session isn't right, we rematch you and refund that session — no call required.* It must be self-serve to be believed; a guarantee that requires a phone call is not a guarantee.
- **Session-level issues** (tutor no-show, broken tech, session under 15 minutes) → one-tap credit from the session detail page, granted automatically under a threshold rather than queued for review. The cost of auto-granting small credits is far lower than the cost of the support interaction and the trust damage.
- **Refund policy on one page, in plain language**, linked from billing and checkout. No prose mazes.
- **Transparent billing:** the parent can always see what she is paying for, what is included (async! sessions! materials!), what unused sessions do, and the exact next charge date and amount — shown *before* it is charged, not after.

---

## 9. Accessibility & mobile-first constraints

### 9.1 Accessibility — target WCAG 2.2 AA, with specific hard spots

This is an education product serving students who disproportionately include those with dyslexia, ADHD, anxiety, and visual or hearing impairments. Accessibility is core functionality, not compliance overhead.

- **Every intake question keyboard-operable**, one question per screen, no time limits, no auto-advance on selection (auto-advance is hostile to switch and screen-reader users and to anyone who misclicks).
- **Live captions in the session room**, on by default, for hearing-impaired students and for anyone in a noisy house. Speech-to-text also produces the transcript that powers the session summary — one investment, two payoffs.
- **The whiteboard is the hard problem.** A freehand infinite canvas cannot be made fully keyboard- or screen-reader-accessible. Do not pretend otherwise. Provide a **parallel accessible path**: the structured document pane with real text, the chat, the equation editor producing MathML rather than images, and a text-based session transcript. A blind student must be able to have a full session through the document + chat + voice path. Flag this as a stated limitation with a named workaround, which is honest and also legally far safer than an overclaim.
- **Maths accessibility specifically:** render equations as MathML/accessible MathJax output, never as images. Screen readers can read MathML; they cannot read a PNG of a quadratic.
- **Dyslexia-friendly options** in settings: font choice (including OpenDyslexic), line spacing, increased letter spacing, and a reading-ruler in the document pane. Cheap to build, disproportionately appreciated.
- **Reduced-motion support** — and note the match reveal is the one animated moment in the product, so it must have a static equivalent that is equally good, not a degraded one.
- **Contrast ≥4.5:1 for text, ≥3:1 for UI boundaries.** Never encode state in colour alone — the skill map's `shaky/solid` states need shape or label as well as hue, since colour-blind users are ~8% of boys, a core demographic.
- **Touch targets ≥44px**, focus rings visible everywhere, forms with real `<label>`s and inline errors tied via `aria-describedby`.

### 9.2 Mobile-first position

- **Mobile-complete:** landing, intake, match reveal, booking, checkout, messaging, homework photo upload, schedule/reschedule, progress, billing, tutor's message replies and offer acceptance.
- **Desktop-recommended:** the session room (§5.3) and the tutor availability editor.
- **PWA, not native.** Installable, offline shell, home-screen icon. **Important constraint to flag:** iOS web push only works for sites added to the Home Screen. Since most of our reminders go to parents and teenagers on iPhones, **web push cannot be the primary reminder channel** — SMS and email are, with push as an enhancement. This should shape the notification architecture from day one rather than be discovered after launch.
- **Real-network testing:** a 3G-throttled test of intake and the match reveal is a release gate. The reveal loading a 4MB hero video on a phone in a car park is the funnel dying silently.

### 9.3 Design system & component library (React/Next.js)

Recommendation, with reasoning:

| Concern | Pick | Why |
|---|---|---|
| Framework | **Next.js App Router + TypeScript** | Server components for the SEO surfaces, one deployment, mature |
| Styling | **Tailwind CSS + CSS custom properties for semantic tokens** | Speed; tokens keep theming and dark mode sane |
| Components | **shadcn/ui on Radix primitives** | You own the source (no vendor lock at exactly the moment you need to customise), Radix gives real accessibility for dialogs, menus, tabs — the things that are hardest to get right by hand. Avoid MUI (heavy, opinionated, hard to make not-look-like-MUI) |
| Forms | **react-hook-form + zod** | Shared validation schema client and server |
| Video | **Buy: LiveKit or Daily.co** | Do not build WebRTC. Recording, TURN, and mobile Safari quirks are a company's worth of work |
| Whiteboard | **Buy/adopt: tldraw or Excalidraw** | Same argument; tldraw has the better multiplayer story and a commercial licence path |
| Math input | **MathLive** (editor) + **MathJax/KaTeX** (render, MathML output) | Accessibility depends on this choice |
| Rich text / notes | **TipTap** | Extensible, good collaborative story |
| Charts | **Recharts** for the progress trend | Small surface area; don't over-invest |
| Scheduling UI | **Build on a headless date lib (Temporal polyfill / date-fns-tz)** | Do not adopt FullCalendar — the booking UX is too bespoke and timezone correctness must be ours |
| Email | **React Email + Resend** | Email is a primary interface here (§1.1); it deserves the same component discipline as the app |
| Motion | **Framer Motion**, used sparingly | The match reveal and a handful of micro-interactions only |

**Design language position:** warm and human, not edtech-corporate and not consumer-app-playful. The buyer is an anxious parent; the register is *a competent, calm school counsellor*. Serif display face for emotional moments (the reveal, the progress report), a clean sans for UI. Real photography of real tutors everywhere — illustration in a trust product reads as concealment. Generous whitespace; a dense dashboard signals "work you have to do", and the parent's dashboard must signal "handled".

Define semantic tokens before building anything: `--surface`, `--surface-raised`, `--text-primary`, `--text-muted`, `--accent`, `--success`, `--warning`, `--danger`, `--focus-ring`. Both light and dark from the start — teenagers do homework at 11pm and a white screen at 11pm is a real usability problem.

---

## 10. What ARCHITECTURE needs to support

Explicit asks, roughly ordered by how much they shape the system:

1. **Household/learner identity model** — one human may hold multiple roles; one subscription spans multiple learners; message-thread visibility is a per-learner ACL driven by age (§1.3, §8.3). Getting this wrong is the most expensive mistake available.
2. **Realtime:** presence (is the tutor in the room yet), typing indicators, live message delivery, session-state sync. Plus the collaborative canvas CRDT — vendor-provided if we adopt tldraw.
3. **Video infrastructure via vendor** (LiveKit/Daily): rooms, tokens, recording to our storage, TURN, mobile Safari support, live transcription for captions.
4. **Recording lifecycle:** encrypted storage, 90-day retention timer, legal hold on report, audited access requests, regional data residency for GDPR. This is a compliance surface, not a file store.
5. **File uploads at volume:** phone photos are the main input — multi-page capture, EXIF stripping (location data in a child's photo is a real hazard), virus scanning, image optimisation, PDF handling, annotation layers stored separately from originals.
6. **Scheduling engine:** timezone- and DST-correct, availability intersection across recurring templates + exception layers + external calendar busy-blocks, booking-conflict prevention under concurrency, .ics generation, two-way Google/Outlook sync.
7. **Notifications:** four channels (email, SMS, web push, in-app) × per-role preferences × a digest engine. Needs quiet hours, per-event routing, and delivery-failure fallback. **Note the iOS web-push constraint (§9.2) — SMS/email must be first-class, not a fallback bolt-on.**
8. **Subscriptions & billing:** Stripe, proration, **pause** (a first-class state, not a cancel-and-resubscribe), refunds and partial credits, session-credit accounting, dunning. Plus Stripe Connect for tutor payouts on a weekly schedule with the async/retainer split of D3.
9. **Matching service:** hard filters (subject, level, language, timezone) → availability intersection → ranked soft-fit score → operator confirmation queue. Must expose *why* each candidate ranked, since the reveal's "Why we matched you" bullets are generated from it. Also needs a supply-gap signal for `/admin/supply`.
10. **Skill-map / curriculum data:** syllabus taxonomies per subject × level × exam board, with per-learner mastery state and a full history for the trend chart.
11. **Background-check vendor integration** with webhooks, expiry tracking and auto-suspension of match eligibility on lapse.
12. **Moderation hooks:** contact-info detection in messages, safeguarding keyword flagging, an immutable audit log for anything touching a minor's data.
13. **Search-engine surfaces:** `/subjects/[subject]` needs real SSG/ISR with structured data — under assigned match this is the main organic channel and it should not be an afterthought.

---

## 11. Open product decisions I need the founder to make

Ordered by how much downstream design they block.

| # | Decision | My recommendation | What it blocks |
|---|---|---|---|
| **D1** | **Assigned match vs marketplace** | Assigned with a 2-tutor visible bench (§2.3) | Literally everything downstream. Decide first. |
| **D2** | **Subscription unit and shape.** Per learner per month with N sessions + unlimited async? Do unused sessions roll over? What does a 15-min extension cost? | Per learner/month, 4 sessions + unlimited async, 1 session rollover max (unlimited rollover destroys revenue predictability and encourages hoarding) | Pricing page, checkout, billing screens, extension UX, the whole value proposition |
| **D3** | **Tutor compensation model.** Per-session only, or session rate + async retainer? | Session rate + **monthly per-student async retainer.** If async is unpaid it dies within a quarter and takes the differentiator with it | `/tutor/earnings`, match-offer earnings display, unit economics |
| **D4** | **Uniform or banded tutor rates?** | Banded (e.g. 3 tiers by qualification/experience) mapped to 3 subscription tiers. Fully variable rates are incompatible with a single subscription price | Pricing, match logic, plan selection |
| **D5** | **Session recording for minors:** default-on? Retention length? Parent access terms? | Default-on, non-disableable, 90 days, parent access on logged request with tutor notified | Safeguarding UX, storage cost, legal, tutor T&Cs, recruiting (some tutors will refuse) |
| **D6** | **Launch geography** | One country, one language, ≤3 timezones. Background-check regimes (DBS vs US state checks vs EU equivalents) are completely different products | Vetting flow, availability UX, legal copy, compliance |
| **D7** | **Public tutor profiles for SEO?** Assigned match means no browse — but public profile pages are strong organic acquisition | Yes to indexable `/tutors/[slug]` pages as *SEO landing surfaces with a "Find my match" CTA*, no to a browsable directory with filters inside the product. Gets the SEO without the choice-paralysis | Public IA, tutor consent, §2's coherence |
| **D8** | **One tutor per student, or one per subject?** | One per subject; a household may hold several. Pricing is per learner-subject | Household model, dashboard IA, pricing |
| **D9** | **Trial shape:** free 30-min intro session, or paid first session under the guarantee? | **Paid first session with a real self-serve refund guarantee.** A free intro attracts tyre-kickers, burns scarce supply on non-buyers, and tutors resent it | Checkout, match reveal copy, CAC, supply load |
| **D10** | **May a parent observe a live session?** | No by default; recording access instead. A parent in the room changes the student's behaviour and suppresses the confidence-building that is half the product. Allow for under-10s if we ever serve them | Session room, safeguarding messaging |
| **D11** | **Public reviews and star ratings?** | No in V1 (§8.2) — reverses if D1 goes marketplace | Tutor profile, match card, tutor incentives |
| **D12** | **Age floor.** Do we serve under-13 (COPPA / GDPR-K verifiable parental consent)? | **Start at 13+** for V1 and add under-13 deliberately. Verifiable parental consent is a meaningful extra build | Signup, consent flow, messaging ACLs |

---

## 12. Suggested build order (UX-driven)

The sequencing principle: build the funnel and the loop that proves the thesis before building the things that scale it.

1. **Prove the reveal.** `/start` → `/match` → `/book` → `/checkout`, with matching done by a human in `/admin/matches` behind the curtain. A landing page, six questions, a real tutor, a real booking. If this does not convert, nothing else matters and no amount of session-room polish will save it.
2. **Prove the loop.** Session room (vendor video + vendor whiteboard, minimal custom code), the 20-second post-session ritual, the parent summary email, async messaging with photo upload. This is the product.
3. **Prove retention.** Skill map, progress screen, monthly report, pause/cancel. This is the renewal.
4. **Scale supply.** Tutor application, status tracker, availability editor, earnings, match offers. Manual ops until roughly 50 tutors, then automate in that order.
5. **Scale demand.** `/subjects/[subject]` SEO surfaces, referral, multi-learner households.

The single riskiest assumption in this document is **that a stranger will hand over a card on the strength of one assigned tutor plus two alternates.** Everything in §1–§3 is an argument for why they will. Step 1 is designed to find out cheaply, in weeks, before the rest is built.
