# Architecture v2 — Campus / Course-Scoped Peer Tutoring

**Supersedes:** `02-architecture.md` (v1) where they conflict. v1 remains valid for everything not restated here.
**Date:** 2026-09-18
**Beachhead:** University of Alabama, adults only, course-scoped, peer tutors, package billing, double opt-in.

---

## 0. What carries over unchanged from v1

Don't re-litigate these; the re-scope doesn't touch them.

- **Next.js 16 alone, no FastAPI** (§4 below re-argues this against the new scoring systems and the answer is still no).
- Better Auth 1.7 · Neon Postgres · Drizzle (1.0 line) · Inngest · Resend · Sentry · Vercel · PostHog.
- Money as integer minor units. Append-only `ledger_entry`. Snapshotted policies. `timestamptz` everywhere + IANA zones.
- Booking overlap prevented by a Postgres `EXCLUDE USING gist` constraint, not app logic.
- Authorization in the data access layer, never in `proxy.ts`.
- `match_run` / `match_candidate` logged append-only with full score breakdowns.
- Repo layering: `modules/*/{repo,service,actions}.ts`, matching kept pure and extractable.

**Timezones just got much easier:** single campus = one timezone (`America/Chicago`). Keep the modeling discipline anyway — it's already written and campus #2 may be in another zone — but the DST test burden drops to near zero for now.

---

## 1. Stripping the minors machinery

### 1.1 Deleted outright

| Removed | Why it's safe to delete |
|---|---|
| `guardianship` table | Zero current use. Re-adding it later is one migration. A dormant table is not free — it shows up in every schema read, every ERD, every "what is this?" from a new contributor. |
| Versioned consent records (`consent_scope`, `terms_version` on guardianship) | Standard adult ToS acceptance on the `user` row is sufficient. |
| Background-check credential gate (DBS/WWCC/state checks) | Not applicable. **But see §1.3 — the `credential` table survives with different semantics.** |
| Age band at intake, age-gated flows | Adults only. |
| `guardian_observer` thread participant role | — |
| Mandated session recording, retention/deletion schedules for minor footage | Founder decision: no recording. |
| Parent dashboards, guardian-visibility ACLs on notes | `session_note.visibility` collapses from 3-way to 2-way (`tutor_private` \| `shared_student`). |
| COPPA / age-of-digital-consent handling | — |

### 1.2 Where I disagree with the coordinator's assumption

> *"I assume the nullable `student_profile.user_id` and the guardianship edge stay, costing nothing."*

**They don't cost nothing, and I'd change both.**

- **Make `student_profile.user_id` `NOT NULL`.** A nullable FK is not a free option — it makes the column `string | null` in every inferred type, forces a null branch in every join and every authorization check, and invites a class of bug where a query silently drops rows. That's permanent friction paid daily for a scenario the founder has now ruled out. If minors ever return, it's a one-line migration, and you'd be revisiting the whole authorization model at that point anyway.
- **Drop `guardianship` entirely.** Same reasoning, less friction saved but also less to explain.

### 1.3 What survives, for reasons that have nothing to do with minors

- **The `user` / `student_profile` / `tutor_profile` split stays** — but the justification changes. It's no longer about guardianship; it's that **on a peer campus model the same person is routinely both.** Your best MATH 125 tutor is a sophomore currently being tutored in CHEM 117. One `user`, two profiles, two score histories that must not contaminate each other. This split is now *more* load-bearing than in v1, not less.
- **`credential` survives with inverted semantics.** It stops being a safeguarding gate and becomes a **competency proof**: transcript or grade-report upload showing the tutor earned an A/B in *this course*. Same table, same verification workflow, same private-bucket storage, different `type` enum values (`transcript`, `grade_report`, `enrollment_proof`). Still a hard gate on listing a course — just for quality, not child safety.
- **Message contact-scanning survives, purely as revenue protection.** See risk #1 — disintermediation is now the top business risk, and it was previously half-justified by safeguarding.
- **Private bucket + signed URLs for credential documents.** Transcripts are FERPA-adjacent education records; don't put them in a public bucket.

### 1.4 Timeline

**I won't claim an improvement. Honest net: roughly +1 to +1.5 weeks over v1's 4–6, so ~5–7 weeks.**

| Delta | Effect |
|---|---|
| Minors machinery removed | **−1.5 wk** |
| Course/section/professor/term entities + catalog ingest | **+1 wk** |
| Double opt-in request state machine | **+1 wk** |
| Package billing + entitlement ledger + refund guarantee | **+0.5 wk** (replaces per-session billing, not additive) |
| Scoring v0 | **+0** — see §4.5, at launch it's a `ORDER BY`, because n=0 for everyone |
| Single timezone, single currency | **−0.5 wk** |

**It drops to 4–5 weeks if sessions are in-person-first and video is cut from the MVP.** Which leads to the question nobody has answered:

> **🔴 DECISION NEEDED: are MVP sessions in-person, online, or both?** Single campus + peer tutors strongly implies students meet in the library. If in-person-first, Daily comes out of the MVP entirely (saves ~4 days), attendance can't be inferred from room-join events (§5.4 — you need a check-in mechanism instead), and disintermediation gets materially easier. I'd assume **in-person primary, online optional**, and design attendance accordingly. This changes the UX track's work too.

---

## 2. Course, section, professor, term, enrollment

This is the substantial new modeling work, and it has one hard problem inside it: **course identity must be stable across terms even though everything else about a course changes every term.**

### 2.1 The entities

```sql
institution                 -- the tenant (see §6)
  id, slug 'ua', name, timezone 'America/Chicago',
  email_domains text[],     -- {'ua.edu','crimson.ua.edu'} — verification AND tenant resolution
  term_system, status

term
  id, institution_id, code 'FA2026', name,
  starts_on, ends_on, add_drop_ends_on, finals_start_on, finals_end_on,
  sort_key int              -- monotonic, for "more recent than"

professor
  id, institution_id, display_name, normalized_name, external_id NULL

course                      -- ★ THE DURABLE IDENTITY. Near-immutable. Scores hang off THIS.
  id uuid, institution_id,
  canonical_key,            -- internal, never a catalog code
  primary_subject_code 'MATH', primary_number '125',
  title, status             -- active | merged_into | retired
  merged_into_course_id NULL

course_code_alias           -- ★ how you survive renumbering
  course_id, institution_id, subject_code, number,
  effective_from_term_sort, effective_to_term_sort NULL

course_offering             -- a course in one term. Ephemeral.
  id, course_id, term_id, catalog_title, credit_hours

section                     -- a section of an offering. Very ephemeral.
  id, course_offering_id, section_code '001',
  professor_id NULL, meeting_pattern jsonb, modality, capacity

enrollment                  -- self-declared at MVP
  id, user_id, section_id, relation,   -- taking_now | took_previously
  verified_via,                         -- self_declared | email_domain | transcript | registrar
  grade_earned NULL, created_at

tutor_course                -- ★ what a tutor is listed for
  id, tutor_profile_id, course_id,
  offering_taken_id,        -- WHICH term they took it — drives staleness
  professor_taken_id NULL,  -- drives professor-match bonus
  grade_earned, credential_id,
  verification_status, rate_minor NULL,
  status                    -- draft | active | paused | retired
```

### 2.2 The versioning rule (the thing that's expensive to get wrong)

> **Tutor history, quality scores, reviews, and packages attach to `course` — the durable entity. Never to `course_offering` or `section`.**

A tutor who took MATH 125 with Prof. Chen in Fall 2024 keeps their MATH 125 score forever. The offering they took is metadata on the relationship (`offering_taken_id`), used to compute **staleness** and **professor affinity**, not identity.

Two corollaries that must be enforced from migration #1:

1. **Never join on the course code string.** `'MATH 125'` is a *label with a validity window*, not a key. All lookups resolve code → `course_id` through `course_code_alias`, filtered by term. When UA renumbers MATH 125 → MATH 1250, you add an alias row and every tutor's history survives untouched. If you'd used the string as a key, that day is a data migration with no clean answer.
2. **Course merges are modeled, not executed.** `status = 'merged_into'` + `merged_into_course_id`, resolved at read time. Never physically repoint rows — you'll want to undo it.

### 2.3 Where does UA course data actually come from?

I checked: **UA runs Ellucian Banner 9 self-service** (the registrar's "Browse Classes" flow). That matters more than it sounds.

| Source | Verdict |
|---|---|
| **Official registrar/SIS API** | Not happening pre-revenue. A student-data integration agreement with a university IT department is a 6–18 month procurement cycle. **Don't plan around it.** Revisit only if a campus partnership materializes — and then it's an unlock, not a dependency. |
| **Banner self-service JSON endpoints** (`StudentRegistrationSsb/ssb/searchResults` and friends) | **The realistic V1 answer.** These return terms/subjects/courses/sections as JSON and are reachable without auth on most Banner installs; there's a well-known community project mapping 750+ institutions that do this. **Strategic bonus: this is the same integration at nearly every US campus you'd expand to**, so the scraper is a reusable expansion asset, not throwaway. Verify UA's specific endpoint behaviour and rate limits, and get a read on ToS before you rely on it commercially. |
| **Manual seed of ~30 courses** | **★ The MVP answer.** Tutoring demand is brutally concentrated in weed-out courses: MATH 125/126, CHEM 101/102, BSC 114/115, PHY 101, ECON 110, CS 100, ACCT 210. Seed those by hand in an afternoon. |
| **Student-submitted + admin approval** | The long-tail mechanism, and it doubles as **demand signal** — "14 students requested a course we don't carry" tells you exactly what to add next. Cheap and worth building at V1. |

**Pushback: you do not need the full catalog to launch.** A complete UA catalog is vanity work that delays the MVP and adds a scraping dependency before you've proven anyone will pay. ~30 courses covers the great majority of real demand. Ship that.

### 2.4 What breaks each term, and how ingest handles it

Each term brings: new offerings and sections, professor reassignments, cancelled sections, occasional renumbering, occasional merges/splits.

**Ingest design (an Inngest job, run at term rollover and nightly during registration):**

- **Idempotent upsert** keyed on `(institution_id, term_id, subject_code, number, section_code)`, resolving the code through `course_code_alias` to an existing `course_id` — creating a new `course` only when no alias matches.
- **Additive only. Never auto-delete.** A failed or partial scrape must not be able to empty your catalog. Disappeared sections get `status = 'not_in_latest_import'`, not `DELETE`.
- **Diff report for human review.** Any run that would create a new `course` (rather than a new offering of an existing one), or that sees >X% of sections vanish, writes a review queue entry and does not auto-apply. New-course creation is where renumbering silently forks your history, so it gets a human.
- **Term churn is contained by design:** `section` rows are term-scoped and disposable, `course_offering` is term-scoped, `course` is near-immutable. The blast radius of a bad term import is one term.

### 2.5 Enrollment verification — be honest about how weak this is

At MVP:
- **Students self-declare** their course and section. `.edu` email verification proves campus, not enrollment.
- **Tutors must prove the grade** — transcript/grade-report upload, human-reviewed, stored in a private bucket. This is the gate that actually matters, because it's your quality floor and your marketing claim.

That asymmetry is correct: a student lying about their section wastes only their own money; a tutor lying about their grade breaks the product. Spend the verification effort on supply.

Registrar-verified enrollment is a V2 unlock if a campus partnership happens. Don't block on it.

---

## 3. `engagement` = course package, and the money flow

### 3.1 Re-model

`engagement` from v1 becomes the package instance. The many-to-many shape survives and now earns its keep differently: a student can hold packages with different tutors for **different courses** simultaneously (MATH 125 with Ana, CHEM 101 with Ben), which is the normal case, not an edge case.

```sql
engagement                            -- = one course package
  id, institution_id,
  student_profile_id, tutor_profile_id,
  course_id, term_id,
  source_request_id,                  -- the accepted match_request
  sessions_purchased, session_duration_min,
  price_minor, currency,
  platform_fee_minor, tutor_rate_minor,
  status,                             -- pending_payment | active | completed | expired
                                      --   | refunded | cancelled
  guarantee_deadline_at,              -- refund window close
  expires_at,                         -- term end + grace
  created_at

entitlement_ledger                    -- ★ APPEND ONLY. Balance is derived, never stored.
  id, engagement_id, delta int,
  reason,                             -- purchase | session_consumed | session_refunded
                                      --   | guarantee_refund | expiry_forfeit | goodwill
  booking_id NULL, actor_user_id NULL, created_at
```

The old `subscription` table is **deleted**. `order` stays (one payment intent per package). `ledger_entry` (money) stays and is now doing real work — see below.

**Drop the v1 partial unique index** (`one active engagement per student`). It was the BetterHelp hedge. The correct constraint now is:

```sql
-- One active package per (student, course, term). Different courses are fine and expected.
CREATE UNIQUE INDEX engagement_one_active_per_course
  ON engagement (student_profile_id, course_id, term_id)
  WHERE status IN ('pending_payment','active');
```

Note this is exactly the v1 hedge paying off: the product angle moved a long way and the schema change is *swapping one partial index for another*. No data migration.

### 3.2 Does "hold funds until post-session" survive an up-front package?

**Yes — and it becomes more important, not less.** This is the sharpest question in the re-scope, so let me be explicit about why.

You collect ~$300 up front for 8 sessions. **You have not earned it.** It is a deferred-revenue liability. If you transfer it to the tutor on day one and the student refunds in week two, you are paying a refund out of money you no longer hold — from a bank balance, at a pre-revenue startup, at exactly the moment growth is consuming cash.

So the v1 call — **separate charges and transfers**, not destination charges — is reinforced:

1. **Purchase:** one `PaymentIntent` for the full package → funds sit in the platform Stripe balance. `entitlement_ledger` gets `+8 (purchase)`. `ledger_entry` records a **deferred revenue liability** of the full amount.
2. **Each session completed:** `entitlement_ledger` gets `−1 (session_consumed)`. `ledger_entry` recognizes 1/8 of revenue, accrues 1/8 of the tutor payable as **pending**.
3. **Weekly batched `Transfer`** to the tutor's connected account for payables that have cleared the guarantee window.
4. **Package expiry** at term end + grace with sessions remaining → see §3.4.

This means your Stripe balance carries a float roughly equal to unearned package value. That's normal and healthy — but **it is not your money, and your dashboard must not present it as revenue.** Derive "recognized revenue" from the ledger, never from the Stripe balance. Getting this wrong is how early-stage companies convince themselves they're profitable.

### 3.3 The first-session refund guarantee

Mechanics:

- Window: **until 24h after session 1 ends**, student self-serve, one click, no reason required. (Founder specified self-serve; friction here defeats the purpose of the guarantee as a conversion device.)
- Refund = **full package price**, including session 1.
- **The tutor still gets paid for session 1. Do not claw it back.** This is a strong recommendation: tutor supply is the bottleneck (§7 risk #2), peer tutors are price-sensitive and churn structurally, and "you did the work and we took your money back because the student bailed" is the single fastest way to poison word-of-mouth in a campus tutor community where everyone knows each other. **The platform eats that cost and books it as CAC**, against a `promotions` ledger account. Budget it explicitly: guarantee-refund rate × first-session tutor pay is a real line item, probably your second-largest variable cost after payment processing.
- Implementation: `stripe.refunds.create` on the PaymentIntent; the session-1 tutor payable releases on its normal schedule; `ledger_entry` records `guarantee_refund` against `promotions`; `engagement.status = 'refunded'`; entitlement zeroed with a `guarantee_refund` delta.
- **Hold the first transfer until the guarantee window closes** so the common case needs no clawback at all.

**Abuse vector, and the cheap hedge:** a student books 6 tutors across 6 courses, takes 6 free first sessions, refunds all 6. Limit to **one guarantee per student per term** (start there; loosen if it proves too tight). Enforce with a partial unique index on `ledger_entry` reason + student + term, not with application logic. Cost: one index.

### 3.4 Unused sessions at term end

**Founder decision needed.** My recommendation: **refund unused sessions at term end, in full, automatically, without being asked.**

Forfeiture revenue is a trap here specifically. On a single campus, everyone talks — the Greek system, group chats, r/rolltide. Breakage income is small, one-time per student, and it buys you a reputation that makes campus #2's word-of-mouth playbook harder. Automatic refunds of unused sessions is a story students tell each other. Take the marketing.

(Alternative if the founder disagrees: roll unused sessions into the next term for the same student, any course. Better than forfeiture, worse than refund, and it creates a liability that never clears.)

### 3.5 Stripe Connect — I'm changing v1's advice

v1 said "manual payouts until tutor #20, then Connect Express." **For this model, adopt Connect Express in the MVP.**

Why the change: a campus launch needs 20–50 tutors fast just to cover ~30 courses with a 5–20-deep deck, so you blow past the manual threshold in week one. And peer tutors churn structurally (they graduate), so you'll be onboarding continuously forever — you need self-serve KYC as a permanent capability, not a milestone.

**The friction is real and it lands on the bottleneck.** Express onboarding asks a 20-year-old for SSN and tax details before they've earned a dollar. Mitigations:
- **Defer KYC until the first accepted request**, not at tutor signup. Let them build a profile, list courses, and appear in decks first; trigger Stripe onboarding at the moment they have money coming. Motivation is far higher at that point. Stripe supports this (`transfers` capability requested later), and it roughly halves the drop-off in my experience of this pattern.
- Set clear expectations in-product about why (it's a legal requirement, not your choice).
- Accept that some tutors won't complete it; track `tutor_profile.payouts_enabled` and exclude them from decks rather than letting a student match with someone who can't be paid.

---

## 4. The two scoring systems

### 4.1 Tutor quality — hierarchical Bayesian shrinkage + Thompson sampling

**Never publicly visible.** Not on profiles, not as stars, not inferable from deck position alone (Thompson's stochasticity helps here — the same student reloading sees a different order, which also masks the ranking).

```sql
tutor_course_score
  tutor_profile_id, course_id,
  -- time-decayed sufficient statistics (half-life ~120 days)
  n_sessions_w, n_ratings_w, sum_rating_w, sum_rating_sq_w,
  n_completed_w, n_no_show_w, n_rebooked_w, n_package_completed_w,
  -- derived, written by the nightly job
  posterior_mean, posterior_var,
  staleness_factor,            -- from offering_taken term vs current term
  responsiveness,              -- from match_request events (§5)
  computed_at, algorithm_version
```

**Three-level partial pooling**, which is exactly what the founder's "strong in Calc I, weak in Organic" requirement asks for:

```
posterior(tutor, course) shrinks toward →  tutor's overall mean across courses
tutor's overall mean      shrinks toward →  that course's mean across tutors
course mean               shrinks toward →  global mean
```

Concretely, at each level: `mean = (k·parent_mean + Σratings) / (k + n)` with `k ≈ 5–8` effective prior observations. So a tutor with 40 great Calc I sessions who lists Organic starts **above a total stranger but well below their own Calc I score**, and converges to their true Organic ability within a handful of sessions. That is the requested behaviour, and it's arithmetic — closed-form, conjugate, no sampler.

**Thompson sampling for exploration.** You already have `posterior_mean` and `posterior_var`, so exploration is one draw per candidate at rank time:

```
rank_score = sample(Normal(posterior_mean, posterior_var))
             + w_prof  · professor_match       -- took it with the student's professor
             + w_grade · grade_earned
             + w_stale · staleness_factor      -- took it recently > took it 3 years ago
             + w_resp  · responsiveness        -- §5.4 — this is the anti-ghosting lever
             − w_load  · current_active_packages / capacity
```

Key implementation point: **the posterior is computed nightly in SQL; the random draw happens per-request in `score.ts`.** The deck is only 5–20 tutors, so it's 20 draws in Node — pure, seedable, unit-testable, and it keeps the v1 extraction seam intact untouched.

Why Thompson over UCB: it's stochastic, so two students looking at MATH 125 get different orderings. That spreads exposure naturally, gathers data faster, and obscures the hidden score. (Elo is correctly rejected — no contest, no win/loss, sparse data, terrible cold start. Not revisiting.)

**Cold start, belt and braces.** Thompson alone can still starve a new tutor if the deck gets truncated in the UI. So add an explicit floor: **at least one of the top 5 deck positions is reserved for a tutor with `n_sessions_w < 3` in this course**, when such a tutor exists. Deterministic, trivially testable, and it guarantees the "real shot" the founder asked for rather than merely making it probable.

### 4.2 Student reliability — and one thing I'd change

Founder intent is clear and right: **reliability, not ability.** Never a public number.

```sql
student_reliability
  student_profile_id,
  -- time-decayed, half-life ~60 days (people improve; a bad September shouldn't haunt April)
  n_bookings_w, n_attended_w, n_late_cancel_w, n_no_show_w, n_payment_fail_w,
  posterior_reliability, band,     -- new | good | watch | restricted
  computed_at
```

**Pushback: drop "preparedness" from the score.** It was on the founder's list, but it's the one component that requires a tutor's subjective judgment of a student, and it will absolutely proxy for ability. The student who shows up without having attempted the problem set is very often the student who *couldn't* attempt it — which is precisely the person the founder said must not be disadvantaged. Including it quietly reintroduces the ability rating through the back door.

**Score only on objective, timestamped events:** attended, late-cancelled, no-showed, payment failed. These are facts with timestamps, not opinions. Keep "preparedness" as a private tutor-facing note field if tutors find it useful for their own planning — just keep it out of the score.

**Surface it as behaviour, not as information.** Reliability should change what the *platform* does, not what tutors *see*:

| Band | Effect |
|---|---|
| `new` / `good` | Nothing. No badge, no signal, no mention. |
| `watch` | Reminder cadence increases; concurrent open requests capped at 1. |
| `restricted` | Deposit required before a tutor accepts; no instant-book. |

I'd resist showing tutors any student badge at all, even for `watch` — the moment it's visible it becomes a scarlet letter and tutors will decline on it. Let it act through platform mechanics. That preserves the founder's intent much more robustly than a "never show a number" rule alone.

### 4.3 Where computation runs

- **Nightly Inngest job** recomputes all posteriors. It's `GROUP BY` with time-decay weights and a few window functions over a table that, at one campus, is thousands of rows.
- **Event-driven incremental update** on session completion / rating / no-show for just the affected `(tutor, course)` pair, so a deck isn't 24h stale after a session.
- **Per-request** in `score.ts`: Thompson draw + the deterministic bonus terms. Pure function.
- Store `algorithm_version` on every write and on every `match_run`, so you can attribute outcome changes to scoring changes.

### 4.4 Does this justify a Python service?

**No. Still Node, and it isn't close.** Making the argument rather than asserting it:

- **Conjugate Bayesian updating is arithmetic.** `(k·μ₀ + Σx) / (k + n)`. There is no sampler, no MCMC, no gradient descent, no optimizer. It is a weighted average computed three times. SQL does this natively; Python would add a network hop to run the same four operations.
- **Thompson sampling is one random draw per candidate.** From a Normal or Beta posterior — 10 lines in Node, and you're drawing 20 of them, not 20 million.
- **Data volume is trivially small.** One campus, ~30 courses, maybe 200 tutors, low thousands of sessions per term. The entire scoring dataset fits comfortably in memory. This is not a data-scale problem and won't be for years.
- **Time decay is `exp(-λ·age)` in a SQL expression.** Not a library.
- **The bandit actively postpones the Python question.** Thompson sampling exists *because* you don't have enough data to fit a model. You cannot train a learned ranker until exploration has produced the data — that's 18+ months and several campuses away, minimum.

**What would still trigger extraction** (updating v1 §1.4 for this model):

1. You want a **genuinely hierarchical model fit from data** — partial pooling with *learned* variance components across campuses, via PyMC/Stan — rather than fixed prior weights you tuned by hand. Realistically needs 3+ campuses and several terms.
2. A **learned ranker** over many features, trained on accumulated `match_run` + outcome data.
3. **Multi-campus scale** where the nightly recompute stops fitting in a job window (a long way off).
4. A Python-leveraged hire.

The seam is unchanged: `score.ts` stays pure, no I/O, no ORM, no clock, seeded randomness. The day you extract, `runMatch` POSTs `TutorFeatures[]` and nothing else in the app changes. **The one new discipline:** keep the Thompson draw seedable and injected, so extraction doesn't also mean reimplementing randomness semantics across a language boundary.

### 4.5 The uncomfortable launch truth

**At launch, n = 0 for every tutor in every course.** Every posterior equals its prior; every Thompson draw is from the same distribution. The Bayesian machinery computes, correctly, that you know nothing.

So **MVP deck ordering is a deterministic sort**, and that's not a shortcut, it's the right answer:

```sql
ORDER BY professor_match DESC,   -- took it with the student's professor
         grade_earned DESC,
         recency_of_taking DESC,
         responsiveness DESC,
         random()                -- genuine tiebreak, spreads early exposure
```

**Ship the `tutor_course_score` schema and the nightly job in the MVP** (they're cheap and you want the sufficient statistics accumulating from session #1), but **ship the Bayesian/bandit ranker in V1**, once ~50–100 ratings exist. Building the full ranker for launch week is optimizing a function you have no data to evaluate.

---

## 5. Double opt-in: the request state machine

### 5.1 States

```
                  ┌─────────► withdrawn (student cancels)
                  │
draft ──► pending ├─────────► declined  (tutor declines, reason captured)
                  │
                  ├─────────► expired   (TTL elapsed)
                  │
                  ├─────────► filled    (student accepted a SIBLING request)
                  │
                  └─────────► accepted ──┬──► converted (package purchased)
                                         └──► lapsed    (student didn't convert in 24h)
```

```sql
match_request
  id, institution_id, student_profile_id, tutor_profile_id,
  course_id, section_id NULL, term_id,
  match_run_id,                 -- which deck this came from + rank shown
  deck_rank, message text,
  status, urgency,              -- normal | urgent (exam within N days)
  expires_at, responded_at,
  decline_reason, sibling_group_id,
  created_at

match_request_event             -- append-only; also the source data for responsiveness
  request_id, from_status, to_status, actor_user_id NULL, at
```

### 5.2 Fan-out policy

**Allow up to 3 concurrent pending requests per (student, course), sharing a `sibling_group_id`.**

- Serial (one at a time) is too slow — it's the design that fails exactly when it matters, during a midterm crunch.
- Unbounded fan-out wastes tutor attention on requests that are already gone, which trains tutors to ignore requests.
- **On acceptance of one, siblings transition to `filled`, not `expired`.** The distinction matters: `filled` must not count against the other tutors' responsiveness, and they get told why ("the student matched with someone else") rather than being left hanging. Tutor goodwill is a scarce resource on the supply-constrained side.

### 5.3 TTL

- **24h default, 12h when `urgency = 'urgent'`.**
- Implemented with an Inngest durable `sleepUntil` per request — no polling sweeper needed, and it survives deploys.
- **At 50% of TTL**, if still pending: nudge the tutor (push/email), and prompt the student to widen to more tutors from the same deck. Don't make the student discover the silence themselves.

### 5.4 "A tutor sits on a request during midterm crunch"

This is the right question to ask, and the fix is mostly **making silence costly and making unavailability explicit** rather than adding more nudges:

1. **Responsiveness is a ranking input** (§4.1, `w_resp`). Not a quality score — a separate factor computed from `match_request_event`: median response time and response rate over a decayed window, where `expired` counts against you and `filled` doesn't. **Tutors who sit on requests sink in the deck.** This is the lever that actually works, because it's self-correcting and doesn't require anyone to police it.
2. **Explicit capacity.** `tutor_profile.max_active_packages`. At capacity → **removed from the deck entirely.** The most common cause of crunch-time ghosting isn't rudeness, it's tutors who are genuinely full. Showing full tutors in the deck is a platform bug, not a tutor failure.
3. **Auto-pause.** After 2 consecutive expirations, flip `tutor_course.status = 'paused'` and notify. Fail closed toward an accurate deck.
4. **Instant-accept (V1).** Tutors opt in to auto-accepting requests for a course while they have open capacity and slots. Removes human latency entirely for tutors who want volume — which is most peer tutors, since they're doing this for money. I'd expect this to become the dominant path and to substantially dissolve the whole problem.
5. **Surface expected response time in the deck** ("usually replies in ~2h") so students self-select toward responsive tutors. Uses data you already have.

Note the reinforcing loop: responsiveness feeds ranking, ranking drives requests, requests are the tutor's income. That alignment does more work than any notification strategy.

---

## 6. The multi-tenancy fork

### 6.1 Pricing the options

**Option A — single-campus now, refactor at campus #2.**
- Cost today: **zero.**
- Cost later: **2–4 weeks plus a risky migration.** Adding `institution_id` to ~20 tables, backfilling, adding NOT NULL, and then auditing *every* query for the missing filter. The failure mode is the bad one: a missed filter doesn't throw, it silently returns another campus's tutors or, worse, exposes one campus's data to another. You'd find some of these in production.
- The catalog tables (`course`, `professor`, `term`) are simultaneously the most relationship-dense and the most obviously tenant-scoped. They're the worst possible thing to retrofit.

**Option B — real multi-tenancy now** (schema-per-tenant, DB-per-tenant, or RLS policies).
- Cost today: **1–2 weeks**, plus permanent operational complexity — per-tenant migrations, connection routing, RLS policies that duplicate authorization logic in a second place (the same trap v1 §3.2 rejected Supabase RLS for).
- **Over-engineering.** You have one tenant and no isolation requirement beyond "don't leak."

**Option C — ★ recommended: "tenant column, single tenant."**
- `institution_id NOT NULL` with an FK on every tenant-scoped table from **migration #1**, always populated with the UA row.
- Scoping enforced in **one place**: the repo layer reads `institution_id` off the actor context, and every tenant-scoped query goes through a `scoped(db, ctx)` helper. Add a test that fails if any query builder in `modules/*/repo.ts` touches a tenant-scoped table without it.
- **Build none of the tenant machinery:** no tenant switcher, no onboarding flow, no per-tenant theming, no per-tenant config, no RLS.
- Cost today: **~1 day.** Cost at campus #2: **days, and no data migration.**

**Recommendation: Option C, unambiguously.** It's the same hedge shape as v1's engagement index — a trivial known cost now against a known future event — and the re-scope has already proven that pattern pays off once (§3.1).

### 6.2 What is and isn't tenant-scoped

Getting this boundary right is most of the value:

- **Global (not scoped):** `user`, auth sessions, `billing_account`, Stripe objects, platform config. A person has one login. Students transfer schools; tutors may eventually tutor online across campuses.
- **Tenant-scoped:** `course`, `course_offering`, `section`, `professor`, `term`, `student_profile`, `tutor_profile`, `engagement`, `match_request`, `booking`, all scores.
- **The bridge:**
  ```sql
  institution_membership
    user_id, institution_id, email_verified_domain,
    role,          -- student | tutor | admin
    status, joined_at
  ```
  This is also your **tenant resolver and verification mechanism in one**: `institution.email_domains[]` maps `@crimson.ua.edu` → UA, verifies campus affiliation, and sets the active tenant context. One mechanism, three jobs.

**A tenant is a campus, not a university system.** UA, UAB, and UAH are three tenants — different courses, different professors, different tutor pools, no shared identity beyond a name.

---

## 7. Revised MVP, repo, risks

### 7.1 The MVP slice (~5–7 weeks; 4–5 if in-person-first)

> **A student picks their course from ~30 seeded UA courses → sees a deck of all tutors for it → sends requests to up to 3 → a tutor accepts → the student buys a package → books and attends session 1 → confirms attendance → the guarantee window opens and closes → remaining sessions draw down the entitlement.**

**In scope:** ~30 manually seeded courses with sections and professors · course-scoped deck with deterministic v0 ordering + a reserved new-tutor slot · double opt-in with 24h TTL and 3-way fan-out · package purchase (single size, per-course price) · entitlement ledger · Connect Express KYC deferred to first acceptance · self-serve first-session refund guarantee · booking + attendance confirmation · messaging (polling) · session notes (2-way visibility) · `tutor_course_score` schema and nightly job **accumulating stats but not yet ranking** · `institution_id` everywhere.

**Deliberately out:** Bayesian/bandit ranking (no data — V1) · catalog scraper (manual seed) · registrar integration · multiple package sizes or tutor-set rates · reschedule self-serve · reviews · calendar sync · real-time sockets · instant-accept · whiteboard · recording · video *if in-person-first*.

**Exit criterion: 10 completed packages** — not 10 first sessions, and definitely not signups. A completed package is the only evidence the model works, because the guarantee makes first sessions cheap to acquire and therefore uninformative.

### 7.2 Repo changes from v1

```
db/schema/
  institution.ts     # NEW  institution, term, institution_membership
  catalog.ts         # REPLACED  course, course_code_alias, course_offering,
                     #           section, professor, enrollment, tutor_course, credential
  identity.ts        # user, student_profile, tutor_profile   (guardianship DELETED)
  matching.ts        # match_run, match_candidate, match_request, match_request_event,
                     #   engagement   (match_proposal → match_request)
  scoring.ts         # NEW  tutor_course_score, student_reliability
  billing.ts         # order, entitlement_ledger, ledger_entry, payout  (subscription DELETED)
  scheduling.ts / messaging.ts / content.ts / audit.ts     # as v1

src/server/
  tenancy/context.ts # NEW  institution context + scoped() query helper
  modules/
    catalog/         # NEW  course resolution via alias, ingest, admin seed
    matching/        # score.ts stays PURE — now hosts the Thompson draw (seeded)
    requests/        # NEW  double opt-in state machine
    scoring/         # NEW  posterior recompute (nightly + incremental)
    billing/         # package.ts, entitlement.ts, guarantee.ts, ledger.ts
  jobs/              # catalog ingest, score recompute, request TTL (durable sleepUntil),
                     #   term rollover, package expiry refunds, payout batch
```

### 7.3 Risk register (re-ranked for this model)

| # | Risk | Hedge |
|---|---|---|
| 1 | **Disintermediation.** Same campus, adults, in-person possible, Venmo exists. Structurally worse than v1's remote model. | Package paid **up front** (leaving mid-package costs the student) · guarantee builds early trust · contact-exchange detection in messages · make the platform carry what the library can't: entitlement balance, scheduling, the tutor's course-specific history. **You cannot fully solve this — price it into unit economics rather than engineering against it.** |
| 2 | **Peer tutor churn is structural.** They graduate; their course knowledge goes stale as professors and curricula drift. | `staleness_factor` in ranking from `offering_taken_id` · continuous self-serve onboarding (hence Connect at MVP) · **your students are your tutor pipeline** — a student who finishes MATH 125 well is next term's MATH 125 tutor; prompt them in-app. Cheapest supply channel you have, and it's a data product you already own. |
| 3 | **Catalog identity corrupted by renumbering.** Silently forks tutor history. | Never key on the code string; `course_code_alias` from migration #1; new-`course` creation gated by human review in ingest. |
| 4 | **Seasonality.** Demand spikes at midterms/finals; near-zero in summer. Packages are term-bound. | Nothing architectural (serverless absorbs spikes). Ops: pre-term recruiting cycles. **Financial: model cash flow on a semester cycle, not monthly.** |
| 5 | **Deferred revenue mistaken for revenue.** Stripe balance holds unearned package money. | Recognized revenue derived from `ledger_entry` only. Never report the Stripe balance as revenue. |
| 6 | **Guarantee abuse.** Free first sessions across many tutors. | One guarantee per student per term, enforced by a partial unique index. |
| 7 | **Connect KYC friction on the bottleneck side.** | Defer onboarding to first accepted request; exclude `payouts_enabled = false` tutors from decks. |
| 8 | **Tutors ghost requests during crunch.** | Responsiveness as a ranking input · explicit capacity removing full tutors from the deck · auto-pause · instant-accept at V1. |
| 9 | **Thin decks in the long tail.** ~30 courses is fine; course #31 has zero tutors. | Student-submitted courses as demand signal; show "we don't cover this yet — notify me" rather than an empty deck. |
| 10 | **Reliability score drifts into an ability rating.** | Objective timestamped events only; drop tutor-judged preparedness (§4.2); act through platform mechanics, not tutor-visible badges. |
| 11 | **Refactor at campus #2** | Option C — `institution_id` from day one (§6). |
| 12 | **Premature Python service** | §4.4 triggers. Require someone to name a fired trigger. |

---

## 8. Decisions I need

1. **🔴 In-person, online, or both for MVP sessions?** Biggest remaining scope lever — determines whether video is in the MVP, how attendance is verified, and how exposed you are to disintermediation. I've assumed **in-person primary, online optional**.
2. **Unused sessions at term end** — refund (my recommendation), roll over, or forfeit?
3. **Package size and pricing** — one fixed size at one price per course (my assumption, simplest), or tutor-set rates and multiple sizes?
4. **Guarantee limit** — one per student per term (my assumption), or per course?
5. **Do you accept eating the tutor's first-session pay on a guarantee refund?** I strongly recommend yes; it protects the bottleneck.
6. **Confirm: drop `guardianship` and make `student_profile.user_id` NOT NULL?** (§1.2 — I'm disagreeing with the coordinator's assumption here.)
7. **Is "preparedness" out of the reliability score?** (§4.2 — I think it quietly reintroduces the ability rating the founder rejected.)

**Assumed unless corrected:** single currency (USD) · single timezone (`America/Chicago`) · tutors are independent contractors · no registrar partnership at launch · ~30 seeded courses · 5–20 tutors per course at steady state.
