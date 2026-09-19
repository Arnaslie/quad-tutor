# UX & Experience Design v2 — Campus / Course-Scoped

**Supersedes:** `03-ux-design.md` (kept intact for reference). **Date:** 2026-09-18
**Locked inputs (not re-litigated):** college students only, minors out, single campus (University of Alabama), course-scoped matching, peer tutors, deck of all tutors for a course, double opt-in, no visible ratings either side, course-package billing, paid first session under a self-serve guarantee.

---

## 0. Headline: the swipe is right, but it is pointed at the wrong side of the marketplace

The founder's instinct is good and the coordinator's defence of the deck is correct — **course scoping genuinely collapses "show everything" and "curated shortlist" into the same list**, so my round-1 argument against browsing is moot and I withdraw it. A ranked, unfiltered, all-tutors-for-this-course deck is the right model.

But apply round-1's scrutiny to the *gesture* rather than the model. Why does swiping work on Tinder?

| Tinder property | Holds here? |
|---|---|
| Deck is effectively infinite (thousands) | **No.** 5–20, often 3. |
| Low information per card; the decision is "do I find this person attractive" | **No.** Grade earned in the course, professor match, price, availability, recency. This is a *comparison* decision, and swiping is the one interaction that structurally prevents comparison. |
| Wrong swipe costs nothing | **No.** Money, and my grade in a course I am currently failing. |
| **A right-swipe is a cheap, parallel, non-exclusive signal of interest** | **This is the one that matters — see below.** |
| Double opt-in creates mutual validation | **Yes**, and it's a genuine fit. |

Three of five fail. But the fifth is the load-bearing one, and it is where the current spec quietly breaks:

**On Tinder, swiping right is not choosing. It is expressing low-cost interest in many people in parallel, and the system resolves it.** The spec as written turns a swipe into a proposal: the student picks one, sends a request, and then *sits in limbo* waiting for one busy 20-year-old to answer. With double opt-in, a single outstanding request is a coin-flip with a multi-hour latency, and the student is failing a midterm on Thursday. That is the funnel's death, and it is not a swipe problem — it is an exclusivity problem.

**Fix: make the swipe mean what it means on Tinder.** A right-swipe is "I'm interested," not "I choose you." The student can have **up to 3 live requests at once**. First tutor to accept gets the first session; the others are auto-withdrawn with a neutral message. This converts the student's wait from *"will anybody say yes"* to *"who says yes first,"* which is a completely different emotional state, and it roughly triples the chance of a same-day match during cold start. It also makes swiping honest: a low-cost, parallel, revocable signal.

So my position, stated plainly:

1. **Deck model: adopted.** Ranked, all tutors, no filters, course does the curation.
2. **Swipe gesture on the student side: adopted, but only with parallel non-exclusive requests (max 3) and a persistent review tray.** A swipe deck where each swipe is a binding, exclusive, blocking commitment is worse than a list.
3. **Swipe on the tutor side: strongly adopted.** This is where the mechanic genuinely belongs — high volume, low information per card, fast binary decisions, no comparison needed. §4.
4. **Below 3 tutors, the deck is not a deck.** Presentation must switch by supply state. §2.4. This is the most important new rule in the document.

---

## 1. Personas, and what collapses

### 1.1 Two personas

**The Student (buyer *and* user — the split is gone).** 18–22, on campus, phone-native, broke, and acutely deadline-driven. Does not want "a tutor for math"; wants to not fail **MATH 125 Exam 2 on October 14**. Buys reactively, usually within 48 hours of a bad exam score, at 11pm. Price sensitivity is high but so is urgency, and urgency wins — which is why packages sized to the *next exam* will outsell semester packages.

**The Peer Tutor.** 19–23, took the course 1–4 semesters ago with a good grade. Motivations, in order: **money** (this is a better campus job than the dining hall), schedule flexibility, and mild status. What they are not: professionals. They will flake, they will over-commit during their own midterms, and — critically — **they graduate.** Supply is a leaky bucket by construction, and the design has to assume a ~4-semester tutor lifespan (§5.5).

### 1.2 What collapses from v1

| Removed | Consequence |
|---|---|
| Parent / guardian persona | `Household → Learner` becomes a plain `User`. One account, one inbox, one card. |
| Payer/user split | Students see prices. All billing UI moves into the student's own app; the "keep money on the parent's side of the wall" rule is void. |
| Age-graded message ACLs | All threads private between the two parties. Retained for dispute/report review only. |
| Monthly parent progress report | **The retention mechanic must be rebuilt from scratch.** §6. |
| Background checks, DBS, credential vetting | Replaced by campus-native trust: .edu + course-grade proof. §8. |
| Recording-on-by-default | Two consenting adults. Recording is **opt-in, both parties**, default off. Sessions may be in person anyway. |
| `/app/learners`, guardian invite, `/invite/[token]` | Deleted. |
| Subject taxonomy | Deleted. The course catalog *is* the taxonomy. |
| 10-day vetting pipeline, screening calls | Replaced by a <48h bar. §5. |

### 1.3 What is new

- **The course catalog is now core product data** — UA course codes, sections, professors, and the academic calendar including published exam dates. Not a nice-to-have: professor-level matching is the entire wedge, and exam dates drive packaging, readiness and notifications. Architecture ask, §10.
- **In-person sessions are back on the table.** Single campus makes meeting at the library the obvious default, and peers will prefer it. v1 assumed video-only; that assumption is dead. §7.
- **Semester seasonality.** This is a sawtooth business, not a monthly subscription. Demand spikes at midterms and finals and goes to near zero between semesters. Retention is fought at semester boundaries, not monthly. §6.4.

---

## 2. The deck (`/deck/[courseId]`) — reworked

### 2.1 Ranking and opacity

Order is by a hidden per-course quality score. **Hidden score, visible reasons** — the round-1 principle survives and matters more here, because a student staring at a stack of peers needs a basis for judgment that isn't "who's cuter." Each card carries 2–3 generated reason chips drawn from real fields:

- `Took it with Prof. Nguyen · Fall 2024 · earned an A`  ← the wedge, always first
- `4 students from your section worked with him`
- `Usually replies in under 2h`
- `Free Tue/Thu evenings — your two best slots`

No filters, no sort control, no "see more like this." The course code already filtered; adding controls re-imports the choice-paralysis we just designed out.

### 2.2 Card content

The card must answer, in one screen, *can this person get me through this exam*:

photo · first name + last initial · class year + major · **the course credential line** (professor, term, grade earned, verified) · price per session · a 30–60s intro video (tap to play, muted autoplay poster) · next 2 open slots · in-person / online / either · reason chips.

Deliberately **not** on the card: any rating, any review count, any "X sessions completed" leaderboard number, any response-rate percentage. All of those are scores by another name.

### 2.3 Interaction

```
  swipe right / [ Ask ]      → adds to your requests (max 3 live)
  swipe left  / [ Skip ]     → removed from this session's deck, recoverable
  tap card                   → expands to full profile, video, full course history
  ↑ swipe up                 → "Ask + message" (attach a note: "I'm lost on related rates")
```

- **A persistent bottom tray** shows `Asked (2/3)` and `Skipped (4) ▲`. Nothing is ever lost — the single worst property of a pure swipe stack is irreversibility, and here the deck is small enough that the student *will* want to go back. One tap reopens skipped cards.
- **Undo** on the last swipe, always.
- After 3 asks, further right-swipes are blocked with an explanation rather than silently ignored: *"You've asked 3 tutors — that's the max. First to accept gets your session."*
- Reaching the end of the deck is a designed state, not a blank screen: *"That's everyone teaching MATH 125 right now."* + the asks you have live + `Notify me when someone new joins`.

### 2.4 Thin state — the rule that keeps this alive at launch

**Presentation is a function of supply count. This is a hard rule, not a preference.**

| Tutors available | UI |
|---|---|
| **0** | Demand-capture screen (§2.5). Never an empty deck. |
| **1–2** | **Not a deck.** Falls back to the v1 single-tutor reveal — full-bleed, hero, "Why we matched you," one primary CTA. A swipe stack of two cards is an insult that announces our own thinness. |
| **3–5** | Deck, but no swipe affordance hinting at infinity — show a visible `1 of 4` counter so the student knows the scope up front and doesn't feel cut off. |
| **6+** | Full deck as designed. |

The failure mode we are avoiding: a student swipes card 1, card 2, hits the end, and concludes the product is empty. Stating the count up front (`4 tutors teach this course`) converts thinness into *completeness* — "that's all of them" reads as honest; "that's all we could find" reads as broken. Same fact, opposite feeling, and it costs one line of copy.

### 2.5 Zero-supply — the screen where the product dies quietly

This is the common case at launch and it deserves real design, not a 404.

```
┌────────────────────────────────────────┐
│  ←  MATH 125 · Nguyen · Sec 004        │
│                                        │
│   No one's tutoring MATH 125 yet.      │  honest, not apologetic
│                                        │
│   You're the 7th student to ask this   │  ← social proof of demand
│   week. We're recruiting for it now.   │    turns failure into signal
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  Notify me the moment someone    │  │
│  │  starts tutoring MATH 125        │  │  PRIMARY. Free, one tap.
│  └──────────────────────────────────┘  │
│                                        │
│  ── Meanwhile ──────────────────────    │
│                                        │
│   3 tutors teach MATH 125 with a       │  ← adjacency ladder:
│   different professor                  │    professor → course →
│   [ See them ]                         │    department
│                                        │
│   2 tutors cover Calculus I generally  │
│   [ See them ]                         │
│                                        │
│  ── Know someone who aced it? ──────    │
│   They can earn ~$25/hr tutoring it.   │
│   [ Send them an invite ]  ← $20 for   │  ← the student recruits
│     you both when they're verified     │    our supply. On a single
│                                        │    campus this actually works.
└────────────────────────────────────────┘
```

Three mechanisms in one screen: **demand capture** (notify), **adjacency** (professor → course → department, each clearly labelled so nobody is tricked into a worse match), and **supply recruitment via the person who most wants supply to exist.** The referral bounty here is the highest-leverage growth spend in the product — a student failing MATH 125 knows exactly who in their dorm got an A in it, and we do not.

Ops counterpart: `/admin/demand` ranks uncovered courses by request volume so recruiting is aimed, not sprayed. Round-1's `/admin/supply` becomes this.

---

## 3. Intake — the course is now the whole question

Round-1 rule applies hard: **never ask what the course code already answers.** The code implies subject, level, curriculum, difficulty, and — with the section — the professor and the exam schedule. Of the original six questions, **three die outright.**

| v1 question | v2 |
|---|---|
| Q1 Who is this for? | **Dead.** Always yourself. |
| Q2 Grade level | **Dead.** The course code implies it. |
| Q3 Subject | **Replaced by course selection** — now the entire intake. |
| Q4 Goal | **Survives, reshaped.** Drives package sizing and the tutor's first-session prep, not matching. |
| Q5 Anything we should know | **Survives.** Still the highest-value free text; attached to the ask. |
| Q6 Availability | **Survives, narrower.** College schedules are blocky and known. |

**Target: deck in under 45 seconds** — faster than v1, because the course collapses four questions into one.

### 3.1 How the student names their course — three doors, ranked

**Door 1 (hero): upload your schedule.** Screenshot from myBama/Banner, or paste the registration page. OCR pulls all 4–6 courses with sections at once, then: *"Found your 5 courses — which one's hurting?"* This is the magic moment of v2 and the direct analogue of v1's match reveal: the product demonstrates it knows something before asking for anything. It also captures the student's *entire* course load, which is the cross-sell and re-engagement asset for the rest of their degree. Make this the primary path even though only a minority will use it — the ones who do are worth several times the ones who type.

**Door 2 (default for most): type-ahead course search.** `MATH 125`, `math 12`, `calc 1`, `Calculus I` all resolve, against the real UA catalog with common aliases. Results show code, title, and the professors currently teaching it. Two taps: course, then section/professor.

**Door 3 (fallback): browse by department.** For the student who genuinely doesn't know the code. Slowest, lowest volume, still needed.

**Professor/section is a required second step** — because it's the wedge, and because "any professor" is a materially worse match that the student should choose knowingly rather than have chosen for them. Offer `Not sure / not listed` (maps to course-level match, badged as such on every card).

### 3.2 The remaining two questions

**"What's coming up?"** — the goal question, reshaped around the course calendar and prefilled from real exam dates:
```
  ○ Exam 2 — Oct 14  (in 11 days)      ← prefilled from the catalog
  ○ The final — Dec 9
  ○ Weekly homework, I'm behind
  ○ I'm lost on one specific thing  → [ short text ]
```
This directly sizes the package (§9) and gives the tutor their first-session brief.

**"When are you free?"** — the week grid, but pre-blocked with the class times we already parsed from their schedule if they used Door 1. A student seeing their own classes already greyed out is a small moment of competence that pays for itself.

**Account wall:** after the deck is visible, before the first ask. **.edu email only** — it is simultaneously the signup, the campus verification and the trust story (§8), which is a rare case of a wall that adds value instead of cost. Magic link, no password.

Deep profile (v1 stage 2) is **deleted**, not deferred. Course + professor + goal + one free-text line is enough for a peer tutor to prepare. Anything more is a survey.

---

## 4. Tutor-side triage — where the swipe genuinely belongs

Every Tinder property that failed on the student side holds here: volume is high (a good MATH 125 tutor gets many requests during midterm week), information per card is low, the decision is binary, no comparison is needed, and a wrong pass costs nothing. **This is the real swipe surface in the product**, and it should get the polish the founder wanted to spend on the student deck.

### 4.1 The request card

```
┌────────────────────────────────────────┐
│  Requests                    3 waiting │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  Marcus T. · Sophomore · Bio     │  │
│  │                                  │  │
│  │  MATH 125 · Sec 004 · Nguyen  ✓  │  │  ← ✓ = your exact
│  │                                  │  │      section match
│  │  "Exam 2 is Oct 14. I bombed     │  │
│  │   the first one. Related rates   │  │  ← their words
│  │   make no sense to me."          │  │
│  │                                  │  │
│  │  Wants: Exam pack · 3 sessions   │  │
│  │  ~$75 to you                     │  │  ← SHOW THE MONEY
│  │                                  │  │
│  │  Free: Tue/Thu eve, Sun aft      │  │
│  │  ✓ Overlaps your availability    │  │
│  │                                  │  │
│  │  ⏱ Expires in 9h                 │  │
│  └──────────────────────────────────┘  │
│                                        │
│   ✕ Pass            ♥ Accept           │
│   ← swipe            swipe →           │
│                                        │
│   ⓘ Marcus has also asked 2 others.    │  ← honest urgency.
│     First to accept gets the session.  │    Real, not manufactured.
└────────────────────────────────────────┘
```

That last line is the parallel-request mechanic (§0) paying off on the supply side: it creates genuine, non-fake urgency, which is the single most effective thing you can do to a 20-year-old's response latency.

### 4.2 Pass is free; silence is not

The mechanic that matters most:

- **An explicit pass costs the tutor nothing** — no ranking penalty, ever. Punishing declines makes tutors accept students they can't serve, which produces no-shows, which is far worse. Structured reasons (`schedule doesn't work` / `at capacity` / `different professor than I took` / `not a good fit`) improve routing.
- **A silent expiry does carry a ranking penalty.** Non-response is the behaviour that actually damages the student experience, because it burns one of their three slots for 12 hours and returns nothing.
- Expiry is **12 hours**, not v1's 24. A student with an exam in 11 days cannot wait a day per request.
- `At capacity` toggle, prominent, one tap, with an auto-resume date. During a tutor's own finals week this is the feature that keeps them from quitting.

### 4.3 After accept

Pre-drafted but never auto-sent intro message, the student's note and course context unlock, and a slot proposal fires immediately from the overlap the system already computed. Target: **accept → first session scheduled in under 60 seconds**, no back-and-forth negotiation. Scheduling friction is where peer matches die.

---

## 5. Peer-tutor onboarding — fast, and not worthless

Round 1 targeted 10 days to first student. **v2 targets under 48 hours**, because peer supply is the bottleneck and speed is itself the recruiting pitch. The verification bar has to change shape, not just shrink: we are no longer certifying *professional competence and child safety*, we are certifying **"you actually took this course and did well in it."** That is a narrower claim, much cheaper to verify, and — because it is course-specific — a stronger signal than any generic credential.

### 5.1 The bar

| Check | How | Time | Why it's the right bar |
|---|---|---|---|
| **Campus membership** | .edu email, magic link | instant | Same-campus identity is the trust story (§8) |
| **Course + grade proof** | Upload the transcript row / degree-audit / grade page screenshot showing course code, term, and grade | <24h human review | **The core credential.** Per-course, not per-person. Unique to this product. |
| **Identity** | Selfie matched to student ID card photo | <24h, same review | Cheap, prevents the one real fraud (someone else's transcript) |
| **Intro video** | 30–60s, in-browser, teleprompter | self-serve | Drives deck conversion; not a gate |
| ~~Background check~~ | — | — | Gone with minors. Do not reflexively keep it; it costs weeks and buys nothing here. |
| ~~Interview / teaching task~~ | — | — | Not at launch. Replaced by the reliability system catching failures within 2 sessions. |

**Bar: A or A− in the course, taken within the last 4 semesters.** Both numbers are visible on the card (`Fall 2024 · A`) so students judge recency themselves rather than trusting a threshold they can't see. A tutor adds courses one at a time, each with its own grade proof — the natural unit is `(tutor, course)`, not `tutor`, and this shapes the whole data model.

At launch, "review" is a human looking at a screenshot for fifteen seconds. Do not build automated transcript parsing before ~200 tutors.

### 5.2 Onboarding flow

`/tutor/apply` — one sitting, ~6 minutes, phone-completable:
1. `.edu` email → magic link.
2. **"Which courses did you ace?"** — the same type-ahead the students use. Pick up to 5. This is deliberately the first real question: it's the flattering one, and it front-loads the thing we most need.
3. Per course: term taken, professor, grade + upload proof. Bulk-upload one transcript screenshot covering several at once.
4. Selfie + student ID.
5. Availability (weekly grid) + in-person/online + preferred campus spots.
6. Rate: **suggested band shown, e.g. $20–30/hr, with the campus median.** Free-set within the band. Peers have no idea what to charge and an empty price field produces both $8 and $80.
7. Intro video (skippable, nagged).
→ Status screen with a real ETA, same as v1's tracker. Profile-building is unlocked during review, not after.

### 5.3 Getting paid

Weekly payouts, fixed day, Stripe Connect. Per-session earnings, per-package view, and a visible `next payout: Friday · $140`. The v1 async retainer is **dropped** — peer tutors won't sustain an async SLA, and promising one we can't keep is worse than not offering it. Messaging exists for logistics and quick questions, with **no response-time promise displayed anywhere.**

### 5.4 No-shows

Student no-show after 15 min → tutor paid in full, one tap. This must be generous and instant; a peer tutor who loses an hour and gets nothing quits that week.

### 5.5 The graduation problem — unique to peer supply, and unsolved by default

Tutors leave on a known date. Design for it explicitly:

- **Recency is displayed and decays.** `Fall 2024 · A` ages visibly; past ~4 semesters the tutor is auto-retired from that course's deck with a prompt to re-verify if the course changed little.
- **Graduation date is captured at signup** and drives a wind-down: 6 weeks out, the tutor stops receiving new requests for packages extending past their last term, and existing students get advance notice plus a pre-matched successor. **Nobody is orphaned mid-package** — that's a refund and a lost student.
- **Succession as a feature:** *"Know a junior who could take this over?"* referral at wind-down. Departing tutors are the best recruiters we will ever have, and they are leaving anyway, so the ask is costless to the relationship.

---

## 6. Progress and outcomes with no parent

The v1 retention mechanic was a monthly report to the payer. The payer is now the student — and **the student already knows whether it's working, because the university grades them.** We cannot out-inform the gradebook, and a dashboard that tries will read as noise.

So the mechanic inverts: instead of *reporting outcomes backward*, the product **organises forward around the course calendar.** The spine is not a monthly cycle; it's the exam schedule.

### 6.1 Exam readiness is the progress screen

The package is "through Exam 2" or "through the final," so the only progress question that matters is *am I ready for the thing on the date*. `/app/course/[id]`:

```
┌────────────────────────────────────────┐
│  MATH 125 · Nguyen · with Marcus       │
│                                        │
│   EXAM 2 · Tue Oct 14 · in 11 days     │
│                                        │
│   You're solid on 5 of 8 topics        │  ← the whole screen in
│   ████████████░░░░░░                    │    one sentence
│                                        │
│   ✓ Product & quotient rule            │
│   ✓ Chain rule                         │
│   ✓ Implicit differentiation           │
│   ✓ Linear approximation               │
│   ✓ Curve sketching                    │
│   ~ Related rates      ← 2 sessions    │
│   ~ Optimization       ← next session  │
│   ○ L'Hôpital's rule   ← not started   │
│                                        │
│   2 sessions left in your pack         │
│   [ Book before Oct 14 ]               │  ← urgency is real,
│                                        │    not manufactured
│  ── Between now and then ──────────    │
│   📝 Practice set from Marcus · due Sun│
│   📷 [ Snap your work ]                │
└────────────────────────────────────────┘
```

Topics come from the **course's actual exam scope** (syllabus/exam blueprint per course — real data, §10), not a generic taxonomy. The tutor sets mastery in the same 20-second post-session ritual from v1, which survives unchanged and is still the only reason any of this data exists.

### 6.2 The outcome loop — post-exam

Two days after a scored exam date: *"How'd Exam 2 go?"* — one tap (`Better than last time / Same / Worse`) plus optional score. The student has genuine selfish motivation to answer, because it reshapes the remaining sessions and they know it. Crucially, this is the **honest tier-split from v1 preserved**: self-reported, labelled as such, never converted into a fake "you improved 23%" claim.

If it went badly, that is the **highest-intent moment in the product** — surface `Add 2 sessions before the final` and, if fit was the issue, a no-friction route back to the deck.

### 6.3 What replaces the parent report: the receipt you show yourself

- **Post-session, 30 seconds:** what we covered, what moved to solid, what's next. Delivered as a push, not an email — students don't read email.
- **Pre-exam brief (T-3 days):** "Here's where you stand on Exam 2's 8 topics." The single highest-value notification in the product, and the one that sells the next package.
- **Course Wrapped, at the final:** sessions, topics mastered, hours, self-reported grade outcome, and a shareable card. On one campus, a shareable "I went from a D to a B in MATH 125" is worth more than any ad we could buy, and it is the closest thing v2 has to the parent report's persuasive function — except the audience is peers, which is the audience that actually drives growth here.

### 6.4 Retention is seasonal — say it out loud

This is a **sawtooth, not a subscription.** Demand spikes at midterms and finals and collapses between semesters. Design consequences:

- **The renewal moment is course registration**, not a monthly billing date. If we captured the full schedule at intake (Door 1, §3.1), we know every course the student is taking *and* can predict next semester's. Re-engagement fires at registration and in week 3 of the new term — the week the first bad quiz comes back.
- **Multi-course expansion within a semester** is the real growth vector per student: *"You're also in CHEM 101 — 6 tutors cover it."* Prompt after a good first session, never before.
- **Do not fight the trough.** Between-semester retention spend is wasted; put it into the week-3 spike instead.

---

## 7. Sessions — in person is now the default

Single campus changes this completely. v1's video-only assumption is void: peers on the same campus will meet at the library, and that's cheaper, warmer and higher-converting than a WebRTC room.

- **Location is chosen at booking**, from a curated list of **public campus spots** (Gorgas Library floor 2, Ferguson Center, specific study rooms) plus `Online`. Free text discouraged.
- **First session must be a public campus location** — the norm is stated in the UI, not buried in terms. Two adults, so this is a lighter touch than v1's safeguarding, but it is still visible design.
- **Online remains fully supported** (video + shared canvas as v1 §5) for evening, off-campus and remote sections. Build it, don't lead with it.
- **Between sessions:** photo-of-work upload survives from v1 and remains the killer input — a phone photo of problem 7 at 11pm is the same interaction on any campus. But with **no SLA displayed** (§5.3).
- **Check-in:** both parties confirm arrival at session start (geofence or a code). This is what makes the no-show system factual rather than he-said-she-said (§8.3).

---

## 8. Trust and reliability

### 8.1 Campus-native trust replaces credentialing

The v1 trust story (background checks, degree verification, safeguarding) is gone. What replaces it is **narrower but more credible to this audience**: not "this person was vetted by a company," but "this person is a real student here who actually aced the exact class you're in."

Badges, all specific, none generic:
```
  ✓ Verified UA student          .edu verified · Class of 2027
  ✓ Took MATH 125 with Nguyen    Fall 2024 · earned an A · transcript verified
  ✓ ID confirmed                 photo matches student ID
```
No opaque "Verified ✓" anywhere — v1's rule that a badge must say *what* was verified survives intact, and it matters more now that there are fewer badges to spend.

Supporting signals: real first name + last initial, photo, class year, major, and *"4 students from your section have worked with him."* Same-campus proximity is doing the work that institutional vetting did.

### 8.2 Reporting

Adults, but harassment and safety concerns are real on campus. `⚑ Report` persistent in the session view and every thread. Categories, free text, immediate human acknowledgement, and — this is the campus-specific part — **a visible escalation path to the university** (Dean of Students / Title IX) with the explicit statement that we will cooperate and preserve records. Both-party block, immediately effective, no explanation required. Academic-integrity reporting too: a tutor being asked to do graded work must have a one-tap route (§8.5).

### 8.3 Reliability without a visible score — the rule

The founder's principle (never rate students by ability, because it disadvantages exactly the students who need help most) is correct and I'd extend it with a clean operating rule:

> **Positive reliability is shown as a badge. Negative reliability is handled by mechanism, never by label.**

A scarlet "2 no-shows" chip on a student's request card is a rating by another name — permanent, context-free, and it punishes the person who had one bad week during their own midterms. And note the asymmetry that justifies the whole approach: **unreliability is a behaviour, ability is a trait.** Gating on the former is fair in a way that labelling the latter never is.

**Shown (positive only, earned, decaying):**
- `On time for all 6 sessions` · `Always confirms` · `Prepared — brings the problem set`
- Absence of a badge is the only negative signal, and it is soft and non-specific. A new student looks the same as a mediocre one, which is correct.

**Mechanisms (invisible to the counterparty, proportionate, recoverable):**

| Behaviour | Consequence |
|---|---|
| 1st late-cancel (<12h) or no-show | Nothing visible. Friendly nudge: *"Heads up — late cancels inside 12h are charged."* |
| 2nd | Parallel request limit drops 3 → 2. Explained to the student, not silent. |
| 3rd+ | Slot deposit required to book; mandatory 12h confirmation or the slot auto-releases. |
| Recovery | Three clean sessions restores everything. **Always recoverable.** |

**Prevention beats reputation**, and it's cheaper: a T-12h confirm prompt with auto-release, plus a T-30m "on my way" ping, eliminates most no-shows outright. Build those before building any consequence ladder.

Tutor side is symmetric: no visible score, but silence and no-shows feed the hidden deck-ranking score (§2.1), which is the strongest possible incentive because it directly controls income.

### 8.4 What the tutor actually sees on a request

Not a rating. Just facts they need: earned positive badges if any, `New to the platform` if applicable, and — only where a deposit is in force — `Slot secured with a deposit`, which reads as reassurance rather than accusation while conveying exactly the same information.

### 8.5 Academic integrity

A peer who took the course, sold by the hour, near a graded exam is an honor-code hazard, and pretending otherwise invites the one PR event that could end a single-campus product. Make it visible and light:
- Both parties accept a short, plain-language **tutoring-not-cheating** standard at signup (explain concepts, work practice problems; don't do graded work, don't share exam content).
- A one-tap `This felt like cheating` report for tutors, who are the ones actually put in the position.
- Never host or index graded materials. Uploaded work is private to the pair and not searchable.

---

## 9. Course packages and the purchase flow

### 9.1 Packaging against the course calendar

Packages are sized to deadlines, not to months. Because we hold the real exam dates, the options are named in the student's own terms:

| Package | Shape | Who buys it |
|---|---|---|
| **Single session** | 1 × 60–90 min | Trial-minded, or one specific blocker |
| **Exam pack** | 3 sessions, expires at the exam date | **The volume seller.** Urgency-driven, bought 7–14 days out |
| **Through the final** | 10 sessions, expires at the final | The good customer; sell this *after* a successful exam pack, never cold |

Expiry is tied to the academic date, which is honest and needs no explanation — and the hard stop means hoarding isn't a risk, so **unused sessions are refunded automatically at course end.** No expiry-forfeiture. It costs little, removes the main objection at checkout, and is the kind of thing students tell each other about.

### 9.2 Payment timing — the double-opt-in trap

**Do not charge at request.** With a max of 3 parallel asks and tutors who may all pass, charging on ask produces a refund queue, a support load and a trust problem in week one.

```
  Ask (free)  →  tutor accepts  →  pick a slot  →  CARD  →  confirmed
                                                    ↑
                                       first charge happens here only
```

The card is captured at the moment of scheduling a real session with a real person who has already said yes. Conversion at that point is high because the uncertainty is already resolved.

### 9.3 Checkout

```
┌────────────────────────────────────────┐
│  ←   Marcus accepted! 🎉               │
│                                        │
│  [photo] Marcus T. · MATH 125 · Nguyen │
│                                        │
│  First session                         │
│   Thu Oct 3 · 6:00pm                   │
│   Gorgas Library, Study Room 2B        │
│                                        │
│  ── Choose your pack ───────────────    │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ ● EXAM PACK        $75           │  │  ← pre-selected from
│  │   3 sessions · through Exam 2    │  │    their intake goal
│  │   Oct 14 · $25/session           │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ ○ THROUGH THE FINAL   $225       │  │
│  │   10 sessions · through Dec 9    │  │
│  │   $22.50/session · save $25      │  │
│  └──────────────────────────────────┘  │
│  ┌──────────────────────────────────┐  │
│  │ ○ JUST THIS SESSION   $28        │  │
│  └──────────────────────────────────┘  │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  🛡 If the first session isn't   │  │  ← the guarantee, at
│  │  right, we refund it and put you │  │    the point of fear
│  │  back in the deck. One tap, no   │  │
│  │  email, no questions.            │  │
│  └──────────────────────────────────┘  │
│                                        │
│  [ Apple Pay ]   card · venmo          │  ← Apple Pay first.
│                                        │    This demographic.
│  Unused sessions refunded at course end│
└────────────────────────────────────────┘
```

### 9.4 The guarantee's refund path — genuinely self-serve

A guarantee that requires an email is not a guarantee. From the post-first-session screen: `Something wasn't right →` → three reasons (`didn't know the material` / `couldn't explain it` / `didn't show up or was late` / `just not a fit`) → **immediate refund confirmation on screen**, no review, no queue. The student is returned to the deck with that tutor removed and their remaining asks restored.

Tutor side: told neutrally, without the reason text, and **a first-session refund carries no ranking penalty on its own** — a pattern across many students does. One bad fit is information; punishing it makes tutors decline the exact struggling students we exist to serve.

---

## 10. Revised screen inventory

**Deleted from v1:** everything parent (`/app/learners*`, guardian invite, `/invite/[token]`, monthly parent report, parent billing view), `/for-parents`, background-check UI, age-gated ACL settings, subject taxonomy pages, the async-SLA surfaces, the deep-profile stage-2 flow.

| Route | Purpose |
|---|---|
| `/` | Landing. Campus-specific: *"MATH 125 kicking you? So did it for Marcus — he got an A."* |
| `/courses/[code]` | **SEO + the growth surface.** One page per course, indexable, shows tutor count. The campus-native analogue of v1's subject pages; students google "MATH 125 tutor UA" |
| `/start` | Intake: schedule upload / course search / browse |
| `/start/course` · `/start/section` | Course then professor/section |
| `/start/goal` · `/start/availability` | The two surviving questions |
| **`/deck/[courseId]`** | **The deck.** Supply-state-dependent presentation (§2.4) |
| `/deck/[courseId]/empty` | Zero-supply demand capture (§2.5) |
| `/tutor-profile/[id]` | Expanded card: video, all courses taught, full credential detail |
| `/signup` | .edu magic link |
| `/app` | Home: my courses, live asks, next session, what's due |
| `/app/requests` | My live asks (max 3), status, withdraw |
| `/app/course/[enrollmentId]` | **Course home — exam readiness, sessions, tutor, pack balance** (§6.1) |
| `/app/messages/[threadId]` | Thread with photo upload |
| `/app/sessions/[id]` | Detail, location, check-in, post-session summary |
| `/app/room/[sessionId]` | Online session room (v1 §5, unchanged) |
| `/app/checkout` | Package purchase (§9.3) |
| `/app/billing` | Packs, balances, refunds, payment method |
| `/app/wrapped/[courseId]` | Course Wrapped, shareable |
| `/app/settings` · `/app/report` | Settings; report a concern |
| **`/tutor/requests`** | **The triage deck** (§4) — the tutor app's home |
| `/tutor` | Today: sessions, unanswered, earnings this week |
| `/tutor/courses` | Courses I teach + per-course grade proof + add a course |
| `/tutor/students/[id]` | Per-student: goal, exam date, topic mastery, history |
| `/tutor/availability` | Weekly grid, capacity, at-capacity toggle, wind-down date |
| `/tutor/sessions/[id]/wrap` | The 20-second post-session ritual (survives from v1) |
| `/tutor/earnings` | Payouts, per-pack breakdown |
| `/tutor/apply/*` · `/tutor/apply/status` | Onboarding + status tracker |
| `/admin/verification` | Grade-proof review queue (the 15-second job) |
| **`/admin/demand`** | **Uncovered courses ranked by request volume** — aims recruiting. Replaces v1's `/admin/supply` |
| `/admin/reports` · `/admin/refunds` | T&S and money |

### 10.1 WIREFRAME — the deck card (`/deck/[courseId]`)

```
┌────────────────────────────────────────┐
│  ←  MATH 125 · Nguyen        2 of 6    │  ← count up front:
│                                        │    thinness → completeness
│  ┌──────────────────────────────────┐  │
│  │                                  │  │
│  │        [ PHOTO / VIDEO ▶ ]       │  │
│  │                                  │  │
│  │                            0:42  │  │
│  ├──────────────────────────────────┤  │
│  │  Marcus T.                       │  │
│  │  Junior · Biology                │  │
│  │                                  │  │
│  │  ✓ Took MATH 125 with Nguyen     │  │  ← THE WEDGE. Always
│  │    Fall 2024 · earned an A       │  │    first, always here.
│  │                                  │  │
│  │  $25/hr · in person or online    │  │
│  │                                  │  │
│  │  • 4 students from your section  │  │  ← reason chips,
│  │  • Free Tue/Thu evenings         │  │    generated from
│  │  • Usually replies in ~2h        │  │    real fields
│  │                                  │  │
│  │  Next open: Thu 6pm              │  │
│  └──────────────────────────────────┘  │
│                                        │
│     ✕              💬             ♥    │
│   Skip         Ask + note          Ask │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │ Asked 1/3   ·   Skipped 2  ▲     │  │  ← nothing is lost.
│  └──────────────────────────────────┘  │    Tap to reopen.
└────────────────────────────────────────┘
```

### 10.2 WIREFRAME — intake, the schedule-upload moment

```
┌────────────────────────────────────────┐
│                                        │
│   Which class is kicking you?          │
│                                        │
│  ┌──────────────────────────────────┐  │
│  │  📷  Screenshot your schedule    │  │  ← HERO. The moment
│  │      We'll pull your courses     │  │    the product shows
│  └──────────────────────────────────┘  │    it knows something
│                                        │
│        ── or type it ──                │
│  ┌──────────────────────────────────┐  │
│  │ 🔍 MATH 12                       │  │
│  └──────────────────────────────────┘  │
│    MATH 125  Calculus I            →   │  real catalog,
│    MATH 126  Calculus II           →   │  aliases resolve
│    MATH 121  Business Calculus     →   │
│                                        │
│         Browse by department  →        │
└────────────────────────────────────────┘

     ↓ after upload ↓

┌────────────────────────────────────────┐
│   Found your 5 courses.                │
│   Which one's hurting?                 │
│                                        │
│   ┌──────────────────────────────────┐ │
│   │ MATH 125 · Nguyen · MWF 9:00     │ │
│   │ 6 tutors                       → │ │  ← supply shown here,
│   ├──────────────────────────────────┤ │    before they commit
│   │ CHEM 101 · Patel · TR 11:00      │ │
│   │ 3 tutors                       → │ │
│   ├──────────────────────────────────┤ │
│   │ HY 101 · Weiss · MWF 1:00        │ │
│   │ No tutors yet — notify me      → │ │  ← honest
│   └──────────────────────────────────┘ │
│                                        │
│   Not listed?  [ Add a course ]        │
└────────────────────────────────────────┘
```

---

## 11. Architecture asks — changed from v1

**Dropped:** household/guardian model, age-based ACLs, recording lifecycle and retention compliance, background-check vendor webhooks, subscription billing with proration/pause, async SLA tracking.

**New or changed:**

1. **Course catalog as first-class data** — UA courses, sections, professors, term-by-term. Needs an ingest path (registrar feed, scrape, or manual seeding at launch) and a plan for it going stale each term. *This is the single biggest new dependency and it gates intake, the deck, packaging and notifications.*
2. **Academic calendar with exam dates** per course/section. Drives package expiry, readiness, and the highest-value notifications. Often unstructured (a PDF syllabus) — assume manual entry for the top 50 courses at launch.
3. **Schedule OCR** for the upload path. Screenshot → course codes + sections. Tolerate failure gracefully into the search path.
4. **Parallel request state machine** — ≤3 live asks, 12h expiry, first-accept-wins with atomic auto-withdrawal of the rest. Race conditions here are user-visible and embarrassing (two tutors both told they won). Needs to be transactional.
5. **Hidden ranking score** per `(tutor, course)`, fed by acceptance speed, silence, completion, refunds, repeat purchase. Must be explainable internally even though it is never exposed.
6. **`(tutor, course)` as the core supply entity**, each with its own grade-proof verification state, recency decay and retirement.
7. **Verification artifact storage** — transcript screenshots and ID photos are sensitive PII (FERPA-adjacent). Encrypted, short retention, access-logged, deleted after verification.
8. **Deposit / hold primitive** for the reliability ladder (§8.3) — a Stripe hold, not a charge.
9. **Session check-in** — geofence or code, both parties, as the factual basis for no-show adjudication.
10. **Notifications:** push + SMS. **Email is now the weak channel** (students don't read it) — the inverse of v1, where the parent lived in email. Exam-date-triggered sends are the highest-value class.
11. **Referral attribution** with two-sided bounty, for the supply-recruitment loop in §2.5.
12. `/courses/[code]` as indexable SSG for organic search.

---

## 12. Decisions still needed

| # | Question | My recommendation |
|---|---|---|
| **N1** | Parallel asks — is 3 acceptable, or does the founder want exclusive 1:1 requests? | **3.** §0 — this is the mechanic that makes double opt-in survivable. If it's 1, expect multi-hour dead ends and design a much more aggressive expiry (4h). |
| **N2** | Who sets price — tutor within a band, or platform-fixed? | Tutor within a suggested band, campus median shown. Fixed price is simpler but peer tutors quit when they can't earn more than the dining hall. |
| **N3** | Take rate, and is it visible to either side? | 20–25%, shown to tutors as gross vs net without editorial. Students see one price. |
| **N4** | In person vs online at launch — build both? | **In-person first**, online as fast-follow. The video room is weeks of work and single-campus demand doesn't need it on day one. |
| **N5** | Grade bar: A/A− only, or A/B+? | **A/A− at launch** — the credential is the product. Loosen only if supply proves binding, and if so, show the grade on the card and let students judge. |
| **N6** | Cold-start: do we seed with paid tutors in the top 10 courses? | Yes. Pick 10 high-enrollment weed-out courses and guarantee coverage. A deck is worthless without supply, and §2.5 only buys patience once. |
| **N7** | Does a student get one tutor per course, or can they use several? | One active pack per course; switching allowed freely. Multiple simultaneous tutors for one course is confusion, not choice. |
| **N8** | Refund unused sessions at course end, or roll to next semester? | **Refund.** Rollover looks generous and reads as a trap; refunding is the story students repeat. |

---

## 13. Build order

1. **Seed one course.** MATH 125, 5–8 verified tutors, manual recruiting. Prove a student will pay a peer.
2. **Intake → deck → ask → accept → checkout → in-person session.** No video, no readiness map, no wrapped. Tutor triage can be SMS to start.
3. **Reliability prevention** (confirm prompts, check-in) before any consequence ladder.
4. **Exam readiness + pre-exam brief** — the retention mechanic, built once there are repeat customers to retain.
5. **Scale to the top 10 weed-out courses**, then the department, then campus.
6. **Online room, Course Wrapped, referral loops.**

**The riskiest assumption in v2** is no longer whether a stranger will trust an assigned match — it's whether **enough tutors exist per course to make a deck feel like a deck.** §2.4's supply-state-dependent presentation and §2.5's zero-state are the two screens standing between a thin launch and a product that looks broken. Build them first, not last.
