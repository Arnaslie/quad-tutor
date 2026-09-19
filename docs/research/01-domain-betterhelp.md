# Domain Analysis: BetterHelp as a Template for a Tutoring Product

**Author:** DOMAIN teammate · **Date:** 2026-09-18
**Audience:** founder + ARCHITECTURE teammate + UI/UX teammate

**Bottom line up front:** Do not clone BetterHelp. But do steal exactly one thing from it — the *assigned, consistent, subscription-cadence relationship* — because in tutoring (unlike therapy) there is hard research evidence that consistency and dosage are what actually produce outcomes. Ditch the rest: the opaque black-box match, the messaging-first product, the one-tutor-forever constraint, and above all the paid-acquisition-funded growth model that is currently unwinding at BetterHelp itself.

Every factual claim below is either **[verified]** with a source, or explicitly marked **[assumption]** / **[unverified]**. I have not invented numbers.

---

## 1. How BetterHelp actually works, end to end

### 1.1 Intake questionnaire

The funnel opens with a fairly long questionnaire (roughly 20–25 screens; **[unverified]** — exact count varies by cohort and A/B test). Verified content categories, from BetterHelp's own FAQ and multiple reviews:

- Demographics: age, gender identity, sexual orientation, relationship status, religious affiliation.
- Presenting issues: what brings you here (anxiety, depression, trauma, grief, relationships, etc.).
- Clinical screeners: sleep, appetite, substance use, self-harm / suicidality risk items.
- Therapy history: have you been in therapy before, are you on medication.
- Preferences about the *therapist*: gender, age band, religious orientation, LGBTQ+ affirming, language, "someone who challenges me vs. listens."
- Availability / scheduling preference.
- Financial-assistance screening is embedded in the signup flow itself (household income, student, veteran status), yielding 10–40% discounts. **[verified]**

Two design observations that matter for us:
1. The questionnaire is **the conversion funnel, not just an intake form.** It is long on purpose — sunk-cost commitment before the price is revealed. The price appears *after* the questionnaire.
2. It collects extremely sensitive data **before** the user has an account. That is precisely what got them into FTC trouble (§2.3).

### 1.2 Matching → ONE assigned therapist

- The user does not browse. After the questionnaire, BetterHelp assigns **one** therapist. Match latency is stated as "a few hours to a few days, depending on therapist availability." **[verified — BetterHelp FAQ]**
- BetterHelp says it uses an algorithm plus "automated tools, including machine learning," considering fit, type of support, and *long-term engagement*, combined with some manual review. **[verified — BetterHelp public statements]** Note that "long-term engagement" is a retention objective, not a clinical-outcome objective. That is a business-metric optimization dressed as a care decision.
- Hard constraints in the match: state licensure (therapist must be licensed in the client's state), availability, specialization, and stated demographic preferences. **[verified]**
- BetterHelp has published very little about the actual mechanism. Reviewers consistently note the opacity. **[verified]**

### 1.3 Pricing: subscription, not per-session

- **$70–$100 per week**, billed every 4 weeks, i.e. roughly **$280–$400 per 4-week cycle**. **[verified — BetterHelp FAQ + multiple 2026 reviews]**
- Price varies by location, therapist availability, and demand. Users cannot see a rate card before completing intake. **[verified]**
- The subscription bundles: unlimited asynchronous messaging in a shared "room," plus (typically) **one live session per week** — video, phone, or live chat, user's choice. **[live-session cadence: widely reported, and Teen Counseling states 30–45 min weekly sessions — verified for Teen Counseling; for adult BetterHelp the FAQ lists the four modalities but does not publish a per-week session count — treat "one 30–45 min live session/week" as the de facto norm, lightly unverified]**
- Cancel anytime, self-serve. **[verified]**
- As of January 2026 BetterHelp has begun accepting insurance in select states (Cigna, UnitedHealthcare, Aetna, Optum), average copay ~$23. **[verified]** This is a strategic rescue attempt, not an original feature — see §1.6.

**The economic trick:** the subscription decouples revenue from consumption. A user who messages twice and never books a live session pays the same as a heavy user. Margin comes from *under-consumption*. This is the single most important mechanic to understand — and the one that translates worst to tutoring (§3.3).

### 1.4 Product shape: async-first, live sessions scheduled on top

The primary surface is a persistent message thread ("your room") with the assigned therapist. Live sessions are scheduled into that thread. Users can message any time; therapists respond on their own cadence. This makes the product feel always-on while costing the platform only the therapist's actual keystrokes.

### 1.5 Supply side: recruitment, vetting, pay

Vetting **[verified — BetterHelp FAQ]**:
- Must hold a real license: PhD/PsyD, LMFT, LCSW, LPC, LMHC.
- Minimum 3 years' experience and 1,000 hours of hands-on experience.
- License verified against state boards; background report; periodic NPDB checks; case studies graded by licensed clinicians.
- BetterHelp states **fewer than one third of applicants are accepted.**

Pay **[verified — Glassdoor/Indeed/ZipRecruiter aggregates and therapist-facing writeups; these are self-reported ranges, treat as indicative not authoritative]**:
- Roughly **$30–$70/hour**, structured as a *volume ladder*: ~$30/hr at 5 hrs/week, rising ~$5/hr per additional 5 weekly hours, needing ~35–40 hrs/week to reach the top of the band.
- Independent private practice for the same clinicians is commonly **$100–$200/hour**.
- Compensation & benefits rated **2.3/5** on Glassdoor by therapists; most report never receiving a raise.

The ladder is the tell: it pays for *volume*, not for *quality or outcome*. That is a structural quality problem, not an accident.

### 1.6 Retention, churn, and paid acquisition — the part that is currently failing

This is the most important section for the founder, and it is well documented in Teladoc's public filings. **[verified]**

- BetterHelp segment revenue: **$240M in Q1 2025, down from $269M in Q1 2024**; **$240M in Q2 2025 vs $265M** a year earlier; **down 9% to $717.2M across the first nine months of 2025.**
- Paying users: **397,000 in Q1 2025, down from 415,000 in Q1 2024**; a further **~5% of paying users lost during Q2 2025.**
- Teladoc's CFO on acquisition costs: *"there is only so much incremental ad spend we can drive in a short period of time without further inflating our customer acquisition costs."* CAC has been repeatedly cited as doubling in specific months and as the direct cause of missed guidance since 2022.
- Ad spend has stayed roughly flat while users fell — i.e. **deteriorating return on marketing**.
- Teladoc committed ~**$30M** to the insurance/in-network pivot as the fix, and has continued to describe BetterHelp as weak through late 2025 / 2026.

**Read this correctly.** BetterHelp is a machine that converts advertising dollars into short-lived subscriptions. It was built on cheap podcast/YouTube/social inventory. When that inventory repriced, the model broke. The average retention window is short enough that the business is essentially a treadmill. **[The specific average subscription length is not publicly disclosed — anything you read claiming "3 months" is unverified.]**

A two-person team cannot win a CAC arms race. Any strategy that requires paid acquisition as the primary channel is off the table for this product, full stop.

---

## 2. Known criticisms and failure modes — the traps

### 2.1 Matching quality
Reviewers and user surveys consistently report the first match being wrong, and the **switching process itself being painful** — just under half of respondents in one review survey described it that way. **[verified — First Session survey; sample and methodology are that publisher's, treat as directional]** Clients seeking a long-term relationship end up in "an extensive and frustrating process of trial and error."

**The trap:** a single opaque assignment with no browsing creates a hard failure mode. If the match is wrong, the user has *no information* about why, no alternatives to compare against, and no agency. The only lever is "reroll," which feels like a slot machine.

### 2.2 Therapist economics → churn → variance
Low pay, a volume-based ladder, 1099 status, no raises. Consequence: high provider churn, and wide variance in responsiveness. Documented complaints include therapists **late for appointments and taking weeks to answer messages**, in direct contradiction of the "message anytime" marketing promise. **[verified — multiple published reviews]**

**The trap:** if you under-price supply, you get the supply you paid for, and the *variance* is what kills you. One bad tutor produces a refund, a churned family, and a negative review; that arithmetic is much worse than the margin saved.

### 2.3 The FTC settlement (March 2023, final order July 2023)
**[verified — FTC press releases]**
- BetterHelp disclosed consumers' **email addresses, IP addresses, and answers to the health questionnaire** to **Facebook, Snapchat, Criteo, and Pinterest** for advertising and retargeting, after promising users it would not.
- **$7.8 million** paid, used for partial consumer refunds; ~**800,000 people** notified as eligible (notices began May 2024).
- The order requires: a **ban** on disclosing health data for advertising/retargeting; **affirmative express consent** before disclosing personal information to certain third parties; a comprehensive privacy program; **directing third parties to delete** previously shared data; and a **data retention schedule**.

**The trap, stated plainly for the architecture teammate:** they built the intake questionnaire and the ad pixels on the same pages, and let the marketing tag manager see the answers. This is an architecture failure as much as a policy failure. Sensitive intake answers must never touch a surface where third-party tags run.

### 2.4 Counselor availability variance
The product promises continuous access; the supply model funds discrete hours. Users get whatever the therapist's actual schedule allows, with no visibility into it before signing up. The mismatch between the *advertised* experience and the *funded* experience is the root of most negative reviews.

### 2.5 "Is it therapy or is it texting?"
The core critique: sessions described as **rushed, surface-level, generic**. Some users suspect ChatGPT-generated replies in the messaging channel. **[verified as a widely reported user perception; whether therapists actually do this is not established]**

**The trap:** async messaging is cheap to deliver and easy to sell, but it degrades into a low-value product that the user eventually notices they're overpaying for. That realization *is* the churn event.

### 2.6 Marketing practices
Beyond the FTC action, BetterHelp's influencer/affiliate marketing has been widely criticized as aggressive and as overstating what the service is. Brand damage has been real and durable.

---

## 3. Where tutoring is genuinely different from therapy

**This is the core of the analysis.** Each difference below either breaks a BetterHelp mechanic or creates an opportunity BetterHelp doesn't have.

### 3.1 Sessions have an external object: a subject, a syllabus, a problem set
Therapy's content is generated in the room. Tutoring's content comes from outside it — a specific textbook chapter, a worksheet due Thursday, an exam board's specification. 

**Implication:** the product cannot be a chat thread. It needs a shared **workspace**: whiteboard, document/photo upload of the homework, equation entry, screen sharing, and persistent per-student materials. This is the single largest engineering delta from BetterHelp and it lands squarely on the ARCHITECTURE teammate. Real-time collaborative canvas + media upload + session recording is an order of magnitude more infrastructure than a messaging thread with a video call bolted on.

**Also:** the object of the session is a natural unit of work. "Photo of the problem you're stuck on" is a far better intake primitive than a 25-question personality survey.

### 3.2 Outcomes are measurable — therapy's are not
A grade moves. A test score moves. A student goes from failing to passing. Therapy has PHQ-9/GAD-7 but no one buys therapy against a number.

**This is the biggest strategic opening.** BetterHelp *cannot* sell on outcome, so it sells on access and convenience, which is why it must buy attention. A tutoring product **can** sell on outcome — and outcome claims are what parents actually share with other parents. That is a word-of-mouth engine BetterHelp structurally lacks, and it is the only viable substitute for paid acquisition at this team's size.

Supporting evidence that outcomes are attainable and that *the BetterHelp-like consistency mechanic is what produces them* **[verified — meta-analyses and the EdResearch/NSSA literature]**:
- Tutoring across ~40 years of preK-12 RCTs raises achievement by ~**0.29 SD** on average; more recent syntheses put high-impact programs around **+0.37 SD**, roughly 3–5 additional months of learning.
- **Dosage dominates.** One meta-analysis found high-dosage tutoring ~**20x more effective in math** and ~**15x more effective in reading** than low-dosage.
- The specific recipe: **three sessions a week, the same tutor for months, small groups, structured curriculum, data used to individualize.**
- Researchers describe a **"relationship effect"** — consistent pairing over months makes students engage with hard material because they trust the person delivering it.

So: the assigned-consistent-provider mechanic is the one part of BetterHelp that is *evidence-backed in tutoring specifically*. Keep that. Discard the rest.

### 3.3 Seasonality is brutal and it breaks the subscription
Demand spikes around exams (AP/SAT/ACT, GCSE/A-level, finals) and collapses in summer and over winter break. **[This pattern is well known in the sector; I did not verify a specific quantitative seasonality curve — treat the magnitude as an assumption, the direction as certain.]**

Consequences BetterHelp never faces:
- A monthly subscription gets cancelled in June and the platform loses the relationship. Annual retention is not a smooth curve; it's a cliff.
- Tutor supply must flex 2–3x seasonally, or tutors starve in summer and are unavailable in May.
- A pure "unlimited-ish subscription" is adversely selected: the people who keep paying through a quiet month are precisely the ones who consume most in a busy month.

**Design response (recommended):** sell **term-length commitments with a defined weekly cadence** (e.g. "2 sessions/week for the 12-week spring term"), not an open-ended monthly plan. This matches the high-dosage evidence, matches the academic calendar, gives the tutor income predictability, and prices honestly. Pausing over holidays should be a first-class, expected product state — not a churn event.

### 3.4 The buyer is not the user
For K-12: parent pays, parent judges, **student attends and can sabotage**. Three distinct parties with different incentives. Therapy's adult-client model collapses all three into one person.

**Implications, which hit UX hardest:**
- Two account types with one shared relationship: parent (billing, reports, safeguarding visibility) and student (the actual session surface).
- The retention loop runs through the *parent*, and the parent never attends a session. So the product must manufacture visible evidence for them: session summaries, progress against goals, what was covered, what's next. **A parent who cannot see progress cancels.** This is the tutoring analogue of the "is it therapy or texting" problem, and it is solvable in a way BetterHelp's is not.
- Student agency matters too. Forcing an unwilling teenager into a match they had no say in is a reliable way to burn the subscription.
- For university students and adult learners the buyer and user reunify — a genuinely different segment with different UX. Do not try to serve both at launch.

### 3.5 One assigned provider does not cover one student's needs
A therapist can carry a whole person. A tutor is scoped to a subject, often to a level and an exam board. A single student may need maths *and* chemistry; next term they need physics instead; in March they need exam technique rather than content.

**This is the load-bearing reason not to copy BetterHelp's one-provider-per-account model.** The correct primitive is not "your tutor," it is **a per-subject engagement** — a durable, consistent pairing *scoped to a subject and a term*, with the student able to hold more than one. Consistency within the engagement (high-dosage evidence), plurality across engagements (subject reality).

### 3.6 Group tutoring is viable; group therapy is niche
Small-group (2–5) tutoring is normal, socially acceptable, often *preferred* by teenagers, and is explicitly part of the high-impact tutoring recipe. It roughly triples effective tutor hourly economics, which is exactly the lever needed to pay tutors well without pricing out families.

BetterHelp has no equivalent margin lever, which is why it had to squeeze therapist pay instead.

**Strategic note:** group is a v2 capability, but the data model must not preclude it. Tell the architecture teammate now: a session has *participants* (plural), not *a student*.

### 3.7 Minors change the legal and product surface — CROSS-CUTTING, FLAG TO BOTH PEERS
BetterHelp explicitly **does not serve minors** (its FAQ states it's not for minors or people under legal guardianship). It spun out a separate brand, **Teen Counseling**, for 13–19 — parent creates the account, signs the consent form, and pays; only then is the teen matched and given their own room. **[verified]** That separation is itself the lesson: **serving minors is a different product, not a setting.**

If K-12 is in scope, these are forced requirements, not options:

- **Verifiable parental consent** before collecting a child's personal information (COPPA, under-13). Note that COPPA amendments with a **April 2026 compliance deadline** have raised the bar on age assurance for edtech. **[verified that this deadline is being widely cited in edtech compliance guidance; the founder should get actual counsel on the specific obligations — I am not a lawyer and did not read the rule text.]**
- **Tutor background checks** — criminal record screening specific to working with minors, plus identity verification. Non-negotiable, and a marketing asset. Wyzant explicitly justifies its 9% student fee partly as paying for tutor vetting. **[verified]**
- **Session recording and/or parent observability.** Safeguarding best practice in the sector is that sessions are recordable and reviewable. This forces storage, retention policy, and consent UX.
- **No unsupervised private channel between an adult and a minor.** All communication must be on-platform, logged, and parent-visible. This directly contradicts BetterHelp's "private room" metaphor.
- **FERPA** applies if you ever integrate with schools or handle records from them. Not at launch, but it constrains any future B2B2C school channel.
- **Payments:** the paying party must be an adult. Billing identity ≠ session identity.

**To ARCHITECTURE:** identity must model *parent account ↔ one or more student profiles*, consent as a first-class, versioned, auditable record, and every communication channel as loggable. Retrofitting this is a rewrite.
**To UX:** there are three distinct logged-in experiences (parent, student, tutor), plus an onboarding flow that necessarily starts with the parent even though the product is for the student. Also: a minor-facing UI has its own bar for dark patterns — do not build BetterHelp's price-hidden-behind-a-25-screen-quiz funnel for a 15-year-old's parent.

### 3.8 Trust is established differently
Therapist credibility comes from licensure — a binary, state-verifiable fact. Tutoring has **no license.** A "maths tutor" could be a PhD or an 18-year-old who did well in the subject last year. 

This means the platform must *manufacture* the trust signal that licensure provides for free in therapy: verified qualifications, subject/exam-board-specific assessment, background check, demonstrated results, reviews. It's more work — but it's also a defensible moat, because the signal is proprietary to your platform.

### 3.9 AI is a live existential variable here, and it is not in therapy
Nobody seriously proposes replacing a therapist with a chatbot for the paid market. But a frontier model *can* explain a maths problem competently and for free. **Chegg is the cautionary tale: revenue fell from $618M (2024) to $377M (2025), Q2 2026 revenue $51.8M — down 51% YoY; subscribers down 31% YoY to 3.2M by Q1 2025; ~22% of staff laid off May 2025 and a further ~45% by October 2025; stock down >99% from its 2021 peak.** **[verified]** The cause was twofold: ChatGPT ate the answer-lookup value proposition, and Google's AI Overviews ate the top-of-funnel search traffic.

**The lesson is precise:** *answer provision* has been commoditized to zero. What has not been commoditized is **accountability, motivation, structure, and someone who notices when you stop showing up.** Anything the product sells must sit on the human side of that line. And Khanmigo's experience confirms the other half: it reached ~770k US student users / ~2M globally, but **only ~15% of students with access used it regularly**, and Khan Academy had to make it auto-activate because "students were not seeking out Khanmigo's help as much as we had hoped." **[verified]** AI tutors have an *adoption* problem, not a capability problem. Humans solve adoption.

---

## 4. Competitive landscape

| Player | Model | Economics | Where it's weak |
|---|---|---|---|
| **Wyzant** | Open marketplace, student browses profiles and books | **25% platform fee from tutor** + **9% service fee from student** (both verified). Tutors set rates $10–$1,000/hr, ~$60/hr average. | Pure search-and-choose. Choice paralysis, no structure, no cadence, no progress tracking. The relationship is ad hoc; the platform adds discovery and payments and little else. Double-sided take is high. |
| **Varsity Tutors** (Nerdy) | **Subscription "Learning Membership"** bundling 1:1 hours + live group classes + on-demand | ~**$199 for 2 hrs** up to **$649 for 8 hrs**/month (one source); another cites ~$349/4hrs and $639/8hrs — **rates vary by tier and time, treat exact figures as approximate**. Tutors are 1099, up to ~$40/hr advertised, with a session-count incentive ladder. | Closest existing thing to "BetterHelp for tutoring," and instructive: the ladder-based contractor pay reproduces BetterHelp's supply problem (modest effective pay, unpaid prep). Also heavily paid-marketing driven. **[assumption on marketing mix]** |
| **Preply** | Marketplace, mostly languages, with **28-day pre-paid lesson cycles** | Sliding commission **33% → 18%** with hours taught; **100% commission on the first trial lesson**. | The trial-lesson clawback and high new-tutor take are notoriously resented; supply quality is variable. Language-dominated, weak in academic subjects. |
| **italki** | Language marketplace | Flat **21%** commission, no unpaid trial, no sliding scale. | Language only. Booking-driven, no curriculum or progress layer. |
| **Superprof** | Lead-generation directory, not a real marketplace | **No tutor commission**; student pays a **~$39 "Student Pass"** to unlock contact. | Doesn't hold the transaction, so it doesn't hold the relationship. Quality unvetted. Basically classifieds. |
| **Chegg** | Content/answer subscription | Collapsing (see §3.9). | Proof that answer-provision is dead as a business. |
| **Khan Academy / Khanmigo** | Free content + free AI tutor, philanthropy/institution funded | Free to the user. | Not a competitor for money; it is a competitor for *the reason to pay*. It resets the floor: content and explanation are free. Also shows AI tutors struggle on voluntary adoption (~15% regular usage). |
| **AI-tutor startups** | AI-first personalized tutoring | **>2,800 AI education startups in 2026** (~18x vs 2023), raising **$4.2B in 2025 = 62% of all edtech VC**. **[verified]** | Massively crowded, undifferentiated, and fighting the adoption problem above. A greenfield two-person team should not enter here on AI alone. |

### Where the actual gap is

Lay the field out and a hole appears in the middle:

- **Marketplaces (Wyzant, Preply, italki, Superprof)** give you *choice* but no *structure*. You pick a person and then you're on your own. No cadence, no curriculum, no progress evidence, no accountability. The parent is buying hours, not outcomes.
- **Subscriptions (Varsity Tutors)** give you *structure* but weak *choice and transparency*, and reproduce the BetterHelp supply squeeze.
- **AI and content (Khan, Chegg, the 2,800 startups)** give you *scale* but no *accountability*, and demonstrably struggle to get students to actually show up.

Nobody is convincingly selling the thing the research says works: **the same well-paid, verified tutor, at a committed high-dosage cadence, over a school term, with visible progress reported to the parent.** Varsity Tutors is closest in shape and furthest in execution quality.

That is the gap.

---

## 5. Recommendation: three candidate angles

### The strategic fork, restated
BetterHelp-style algorithmic match to ONE provider on a subscription **vs.** open marketplace browse-and-book **vs.** something else.

**My answer: something else — and it is specifically a hybrid that resolves the fork rather than splitting the difference.** Assignment vs. browsing is a false binary; the real variables are (a) who bears the cost of choosing and (b) whether the relationship has a committed cadence. You can give users a *curated shortlist* (low choice cost, real agency) and then lock a *term-length engagement* (committed cadence). That is neither BetterHelp nor Wyzant.

---

### ★ ANGLE A (PRIMARY): "The Term Engagement" — curated shortlist → committed high-dosage pairing, priced per subject per term

**Core bet:** In tutoring, outcomes come from *dosage and relationship continuity*, and the evidence for this is unusually strong. The product that operationalizes cadence and continuity — and proves it to the parent every week — wins on results, and results are the only marketing channel a small team can afford.

**Mechanics:**
1. **Short, honest intake (5–8 questions, ~2 minutes).** Subject, level/exam board, goal ("pass" / "B→A" / "SAT 1400+"), availability, and a photo of a current piece of work. **Price is shown before intake, not after.** This is a deliberate anti-BetterHelp choice.
2. **Matching produces a shortlist of 3, not an assignment of 1.** The algorithm does the hard filtering (subject, level, exam board, availability, verified credentials, past results with similar students); the human does the final pick. This kills BetterHelp's worst failure mode — a wrong opaque match with no agency — at near-zero cost.
3. **A free or low-cost first session** as the real matching test. Paid to the tutor by the platform, not clawed back from them (explicitly unlike Preply). Treat it as CAC, because it is.
4. **The unit sold is a per-subject term engagement:** e.g. 2x/week × 12 weeks, one named tutor, fixed slot. Not "unlimited," not a rolling monthly. Pauses over holidays are expected and built in.
5. **A student can hold multiple concurrent engagements** across subjects. This is the explicit fix for BetterHelp's one-provider constraint (§3.5).
6. **Every session produces an artifact:** what was covered, what was hard, what's set for next time, confidence rating. Delivered to the parent automatically. This is the product's retention engine and its referral engine.
7. **Switching is a first-class, blame-free flow** with the reason captured and fed back into matching. If a shortlist fails, that's the algorithm's fault, not the family's.
8. **Pay tutors well and say so publicly.** Target a take rate materially below Wyzant's combined 25%+9%. **[The specific number is a business decision I'm flagging, not making — see open questions.]**

**Who it serves:** initially **one segment, one subject family, one exam** (recommendation: high-school maths/science for a named national exam or standardized test). Parent is buyer, student aged ~14–18 is user.

**Why it could win:**
- It is the only model aligned with what the research says actually works. Every competitor either sells hours (marketplaces) or sells access (subscriptions); none sells *dosage + continuity + evidence*.
- Outcomes → word of mouth → survivable CAC. This is the whole ballgame for a small team, and it is precisely what BetterHelp cannot do.
- Term pricing solves seasonality honestly instead of pretending it doesn't exist.
- AI-proof: the value is accountability and a person, not answers.
- Narrow launch scope means marketplace liquidity is achievable with a genuinely small number of tutors. **[assumption: ~10–20 excellent tutors in one subject/exam is enough for a first cohort — validate before committing]**

**Main risk:** **Commitment friction.** Asking a parent for a 12-week commitment to an unproven brand is a much harder first sale than "book an hour for $50." The free first session is the mitigation, but if conversion stalls, the model has to bend — probably to a 4-week starter engagement. **Secondary risk:** supply quality at low volume; one bad tutor is a meaningful fraction of early experience.

---

### ANGLE B (ALTERNATIVE): "Vertical Exam Specialist" — one exam, group-first, outcome-guaranteed

**Core bet:** Go absurdly narrow — a single high-stakes exam (one SAT/ACT, or one national exam board's subject). Own it completely: known curriculum, known timeline, known scoring, cohorts that start and end together. Lead with **small groups of 3–5** and 1:1 as the premium add-on.

**Who it serves:** exam cohorts and their parents, in the 3–6 month run-up.

**Why it could win:** Group economics fix the pay problem — you can pay tutors genuinely well *and* undercut 1:1 pricing, which no 1:1 competitor can match. Curriculum is built once and reused across every cohort, so quality compounds instead of depending on individual tutor talent. The outcome is unambiguous and marketable, and a score guarantee becomes possible. Seasonality becomes the business model rather than a problem: you run cohorts, not subscriptions. Word of mouth is dense because cohorts are socially connected.

**Main risk:** Seasonality is *severe* — you may have one or two real selling windows per year, so a bad window is a lost year and cash flow is lumpy. Also, cohort scheduling is genuinely hard (5 families' calendars must intersect), and one dropout damages the group's economics and dynamics.

---

### ANGLE C (ALTERNATIVE, weaker): "Transparent Marketplace Done Right"

**Core bet:** Wyzant and Preply are ten-year-old products with bad UX, high take rates, and resented fee structures. Rebuild the marketplace with a low take rate, real verified credentials, no trial-lesson clawback, and a good booking/session experience.

**Why it could win:** Simplest thing to build and the lowest-friction first sale. Tutor acquisition is easy if the take rate is genuinely better — bring-your-own-students is a real cold-start strategy here.

**Main risk:** **This is the one I'd advise against.** It is a two-sided cold-start with no structural advantage; marketplaces win on liquidity and brand, which are exactly what a two-person greenfield team lacks. Take-rate undercutting is not a moat — incumbents can match it and outspend you. And it sells hours, not outcomes, so it inherits the worst dynamic: nothing to say to a parent except "here are some people."

---

### Defending the primary choice

**Why not BetterHelp's model?** Because the two things that make it work in therapy are absent in tutoring. (1) Therapy has no measurable outcome, so selling access is the only option; tutoring has outcomes, so selling access leaves the strongest weapon unused. (2) One therapist can cover a whole person; one tutor cannot cover a whole student. And the model's growth engine — paid acquisition — is visibly failing at BetterHelp itself, with declining revenue and users through 2025 and into 2026. Copying a model at the moment it is publicly breaking is a poor trade.

**Why not a pure marketplace?** Because the marketplace hands the hardest problem — choosing well and maintaining a cadence — back to a parent who has no way to solve it, and it gives the platform nothing to defend. It also makes the AI threat worse: if all you provide is discovery, you are a directory, and directories are what Google's AI Overviews just finished eating.

**Why the hybrid is not a fudge:** the shortlist-of-three is strictly better than both extremes. Versus assignment, it preserves agency and avoids the "painful switch" failure mode at trivial cost. Versus open browse, it removes choice paralysis and lets the platform enforce quality by controlling who appears. Meanwhile the term engagement gives the platform a real product to deliver — cadence, continuity, and reporting — rather than a transaction to broker. **Angle A is the only one of the three where the platform is doing work a spreadsheet and a WhatsApp group couldn't do.**

---

## 6. Cross-cutting decisions my teammates must know

**To ARCHITECTURE:**
1. **Minors in scope ⇒ identity is parent↔student, not user.** Consent must be a versioned, auditable first-class record. Do not model this as a profile field.
2. **Sensitive intake data must be isolated from any surface where third-party marketing tags execute.** This is the direct, literal lesson of the FTC order. Assume a data retention schedule will be required.
3. **All tutor↔student communication must be on-platform, logged, and parent-inspectable.** No off-platform contact exchange. Safeguarding requirement, and also the marketplace-disintermediation defense.
4. **A session has participants (plural), not a student.** Group is coming; don't preclude it in the schema.
5. **Real-time collaborative workspace (whiteboard, file/photo upload, screen share) plus recording and retention is the dominant infrastructure cost.** This is where FastAPI (or a realtime service) may be justified. This is *not* a chat app with video bolted on. Recording storage + retention policy is a real cost line.
6. **Scheduling with recurring slots, timezones, holidays, cancellations, and make-up sessions is deceptively hard** and is core to the term-engagement model, not peripheral.
7. **Billing is term-based with pauses, not a simple monthly subscription**, and the payer is a different entity from the user.

**To UX:**
1. **Three distinct authenticated experiences:** parent, student, tutor. Onboarding necessarily starts with the parent; the student must still feel ownership of their own space.
2. **Price is visible before intake.** Explicitly rejecting BetterHelp's hide-the-price-behind-a-long-quiz funnel. Intake is ~2 minutes, not 25 screens.
3. **The shortlist-of-three screen is the most important screen in the product.** It must make comparison easy and fast without triggering choice paralysis — three, with the *reasons* for each match shown.
4. **The parent's progress view is the retention surface.** A parent who cannot see what happened cancels. Session summaries must be automatic, not tutor homework.
5. **Switching tutors must be visibly blame-free and easy** — the opposite of BetterHelp's most-complained-about flow.
6. **The session surface is a workspace, not a chat.** The homework is on screen; the video is secondary.
7. **Safeguarding cues should be visible, not hidden** — "sessions are recorded," "your tutor is background-checked," "all messages are visible to your parent." For this buyer these are features.

---

## 7. Open questions only the founder can decide

1. **K-12 minors, or adults/university only?** This is the single highest-leverage decision and it must be made first. Minors bring the bigger market, the parent buyer, and the word-of-mouth density — but also COPPA/consent, background checks, recording, and a three-party product. Adults are far cheaper to build for and a much smaller, more price-sensitive market. *Everything in the architecture and UX plans forks here.*
2. **Which single subject and which single exam for launch?** Narrow beats broad, and the choice determines supply strategy, curriculum, and the outcome claim.
3. **Geography.** One country/region/exam board, or multi-market? Drives licensure-equivalent checks, background-check vendors, timezone/scheduling complexity, and legal obligations.
4. **Take rate and tutor pay target.** If you intend to compete on tutor quality, you must beat Wyzant's combined 34% (25% tutor + 9% student) and Preply's 33% entry rate. What margin does the founder need, and does the unit economic close at a rate that attracts genuinely good tutors?
5. **Term length and cadence for the v1 engagement.** 12 weeks × 2/week is what the evidence supports; 4 weeks × 1/week is what a nervous first-time buyer will say yes to. Which friction is the founder willing to eat?
6. **Group from day one, or 1:1 first?** Group fixes the economics but adds scheduling complexity and delays launch.
7. **Cold-start supply strategy.** Recruit tutors individually and hand-vet (slow, high quality), or let tutors bring their existing students (fast liquidity, quality risk)? For Angle A, hand-vetting is the answer — but it caps early growth.
8. **What is the outcome promise, and is it guaranteed?** A guarantee is the strongest possible differentiator against every competitor and a real financial liability. Decide deliberately.
9. **AI's role.** My recommendation: use AI *behind* the product — session summaries, practice generation, matching, progress detection — and never sell it as the tutor. The founder should confirm they're comfortable not competing in the AI-tutor category.

---

## Appendix: confidence ledger

**Verified with sources:** BetterHelp pricing range and 4-week billing; therapist credential and vetting requirements; the <1/3 acceptance rate; match latency and the assignment model; the four communication modalities; BetterHelp's exclusion of minors and the separate Teen Counseling product with parental consent; the full FTC settlement (parties, data types, $7.8M, ~800k refund notices, order terms); Teladoc/BetterHelp 2025 revenue and paying-user declines and the CAC commentary; Chegg's revenue, subscriber, layoff and stock figures; Khanmigo's user numbers and ~15% regular-usage figure; the AI-edtech startup and funding counts; Wyzant's 25%/9% fees; Preply's 18–33% sliding commission and 100% trial commission; italki's 21%; Superprof's Student Pass model; Varsity Tutors' membership structure; the tutoring effect-size and high-dosage meta-analytic findings.

**Self-reported / directional, not authoritative:** BetterHelp therapist pay ranges and the 2.3/5 Glassdoor compensation rating (aggregator and survey data); review-site survey findings on switching pain and session quality; Varsity Tutors' exact tier prices (sources disagree).

**Explicitly unverified or assumption:** the exact number of BetterHelp intake questions; the precise per-week live session entitlement for adult BetterHelp; average BetterHelp subscription length (not publicly disclosed — distrust any figure you see); quantitative tutoring seasonality curves; the minimum tutor count for launch liquidity; the specific obligations under the 2026 COPPA amendments (needs actual legal counsel); Varsity Tutors' marketing mix.
