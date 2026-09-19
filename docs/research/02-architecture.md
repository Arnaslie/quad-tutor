# Tutor Helper Finder — Architecture

**Author:** Architecture track
**Date:** 2026-09-18
**Status:** Opinionated proposal, pre-reconciliation with Domain and UI/UX tracks

---

## 0. TL;DR

| Question | Verdict |
|---|---|
| Next.js alone or + FastAPI? | **Next.js alone.** No Python service until a named trigger fires (§1.4). The seam is `src/server/modules/matching/`. |
| ORM / DB | **Drizzle + Postgres on Neon.** Plain-SQL committed migrations. Postgres is the asset, the ORM is not. |
| Auth | **Better Auth**, self-hosted in the Next app. Not Clerk (per-MAU cost across 3 personas + guardianship modeling). |
| Assigned tutor vs marketplace | **Schema is many-to-many from day one.** BetterHelp mode is a *droppable partial unique index*, not a schema shape. This is the single most important decision in the document. |
| Video | **Buy. Daily Prebuilt** at MVP, LiveKit if you cross ~200k min/mo. |
| Whiteboard | **Defer entirely.** Screen share at MVP. |
| Payments | **Stripe.** Connect Express *if and when* you pay tutors through the platform — and the retrofit cost scales with tutor count, so decide before tutor #20. |
| Matching engine | **Weighted SQL scoring.** Embeddings at launch are resume-driven. But log every match run from day one — that log is the only thing that lets you improve later. |
| Jobs | **Inngest.** Not BullMQ (needs a persistent worker = the second deploy target we're avoiding). |

**The MVP slice:** a student completes intake → is matched to a tutor → books and pays for one real session → both join a video room → tutor writes a note. Everything else is manual ops.

---

## 1. The central question: Next.js alone, or Next.js + FastAPI?

### 1.1 Verdict

**Next.js alone. One repo, one deploy target, one language, one auth context.** FastAPI does not earn its place at this stage, and there is a specific, cheap seam that makes adding it later a ~1 week job rather than a rewrite.

### 1.2 Why the split is expensive *right now*

These are not abstract concerns; each is a recurring tax on every feature you ship:

- **Two deploy targets, two CI pipelines, two dependency ecosystems, two secret stores.** Every env var exists twice or is forgotten in one place.
- **Auth becomes a distributed systems problem.** Next holds the session cookie. FastAPI has no idea who the user is. You now build service-to-service auth (signed internal JWT, shared secret, or forwarding the session) *and* re-derive authorization in Python. **Duplicated authz is where security bugs live** — "can this parent read this thread?" implemented twice, drifting.
- **Two migration tools against one database.** Alembic and drizzle-kit both wanting to own the schema is a genuine footgun. The alternative — Python reads a schema it doesn't own — means Python breaks silently on every migration.
- **Type duplication.** Your Drizzle inferred types do not exist in Python. You either hand-maintain Pydantic mirrors (drift) or generate OpenAPI → TS (build step, still drifts on the Python side).
- **Local dev friction.** Two processes plus a venv plus a Postgres. Every new contributor pays this on day one, forever.
- **A network hop inside what was a function call.** Matching goes from a 20ms query to a 20ms query plus serialization plus HTTP plus deserialization, and now it can fail partially.
- **CORS**, or a proxy layer to avoid CORS, which is more config.

For a small team shipping an MVP, this is roughly a 20–30% tax on velocity in exchange for zero capability you need today.

### 1.3 What would *genuinely* justify a Python service

Be honest about which of these are real:

| Justification | Real? |
|---|---|
| **Training and serving a learned ranking model** — LightGBM/XGBoost over outcome data, with a feature pipeline, retraining cadence, and offline eval harness | **Yes, genuinely.** This is Python's home turf and TS has no real equivalent. But it requires 6+ months of outcome data you don't have. |
| **Constraint solving / optimization** — e.g. OR-Tools for group-session timetabling, cohort assignment, or global schedule optimization | **Yes.** No credible JS equivalent. Only relevant if you do group/cohort products. |
| **Heavy offline data work** — cohort analysis, churn modeling | **Yes, but this isn't a FastAPI service.** It's notebooks or dbt against a read replica. Don't build a web service for it. |
| **Your strongest engineer is a Python person** | **Yes.** Team composition beats architectural purity. Say so out loud if true. |
| "Matching is ML-ish, so it should be Python" | **No.** At <1,000 tutors, matching is a weighted SQL query (§3.7). |
| "We need embeddings / vector search" | **No.** Call an embedding API over HTTP from Node, store vectors in `pgvector` in the same Postgres. Zero Python involved. |
| "Python is better for background jobs" | **No.** Inngest in TS handles durable steps, retries, and cron fine. |
| "Separation of concerns" | **No.** You get that from module boundaries. A network hop is not an architecture. |
| "We'll need it eventually" | **No.** Adding it later costs a week *if you build the seam*. Carrying it from day one costs every week. |
| "We need a mobile app, so we need a real API" | **No — but it's a real need with a different answer.** The answer is Next Route Handlers or tRPC, not a second language. |

### 1.4 The extraction seam, precisely

Build matching as an isolated module with a pure core:

```
src/server/modules/matching/
├── types.ts          # Intake, TutorFeatures, ScoredCandidate, Weights — the future wire contract
├── candidates.ts     # THE ONLY FILE THAT TOUCHES THE DB. Returns TutorFeatures[].
├── features.ts       # buildFeatures(intake, tutorRow) -> Features. Pure.
├── score.ts          # scoreCandidates(features[], weights) -> ScoredCandidate[]. PURE. No I/O, no ORM import, no Date.now().
├── weights.ts        # loaded from a DB config row, not hardcoded
└── index.ts          # runMatch(studentProfileId) -> MatchRun  — the orchestrator, the only public export
```

**Enforcement rules (add an ESLint `no-restricted-imports` rule for these):**
- `score.ts` and `features.ts` may not import the DB client, the ORM, or anything from `src/app/`.
- `score.ts` is deterministic: same inputs → same outputs. No clock, no randomness (seed it if you need tie-breaking jitter).
- Only `index.ts` is imported by the rest of the app. Nothing else reaches into the module.

**The extraction, when it happens:** `runMatch` stops calling `scoreCandidates` locally and instead POSTs the serialized `TutorFeatures[]` to a Python service. The wire contract already exists as `types.ts` — publish it as JSON Schema. The Python service either scores the payload it's handed (stateless, easiest) or reads features from a Postgres read replica. **Nothing outside the matching module changes.**

**Triggers for extraction — write these down and check them quarterly:**

1. You have ≥6 months of outcome data (completed sessions, retention, ratings, churn) **and** tuning weights by hand has plateaued, so you want a learned ranker.
2. p95 match latency exceeds ~500ms with SQL scoring, **and** you've already added the obvious indexes and materialized the expensive features.
3. You need a constraint solver (group scheduling, cohort assignment).
4. You hire someone whose leverage is materially higher in Python.

**None of these are true at MVP.** If someone argues for FastAPI now, ask which trigger fired.

### 1.5 Second seam worth naming

**Realtime.** If you ever need a persistent websocket server, that is genuinely awkward in serverless Next. The answer is still not Python — it's **buy a hosted pub/sub** (Pusher, Ably) or run a small dedicated Node service. See §3.3.

### 1.6 Next.js specifics (given 16.x)

Verified current as of today: **Next.js 16.3.5**, **React 19.3.0**. Notes that affect the design:

- **`middleware.ts` is now `proxy.ts`** (renamed in the 16 line) and **defaults to the Node.js runtime**; the `runtime` config option is not available there. If you scaffold from an older tutorial, your auth matcher silently stops running.
- **Do not put authorization in `proxy.ts`.** Use it only for coarse traffic control ("no session cookie → redirect to /login"). Real authz belongs in a data access layer that every server action and query passes through. This is the direct lesson of the 2025 middleware-bypass vulnerability class: a network-boundary check is not an authorization check.
- **Server Actions for mutations, Route Handlers for webhooks** (Stripe, Daily, Inngest) and any future public API.
- **Skip tRPC for now.** Server Actions + typed server functions cover it inside one app. Add tRPC only when a second client (mobile) appears — that's the moment it earns its keep.
- **Cache Components / `use cache` / PPR:** use on the public marketing pages and (if you go marketplace) the tutor directory. The authenticated app is per-user dynamic; don't chase PPR there and don't let caching accidentally leak one user's data to another.
- Anything touching the DB runs in the **Node runtime**, not edge.

---

## 2. Data model

Postgres. Integer minor units for all money (`amount_minor BIGINT` + `currency CHAR(3)`) — never floats, never `NUMERIC` treated casually. All instants are `timestamptz`; the session `TimeZone` is `UTC`.

### 2.1 The decision that is expensive to reverse

**A student has *relationships* with tutors — plural — from day one.**

Do **not** put `assigned_tutor_id` on the student. The product angle is unsettled, and this is the one modeling choice where guessing wrong means a data migration under load plus rewriting every query that touches tutoring.

```sql
CREATE TABLE engagement (
  id                  uuid PRIMARY KEY,
  student_profile_id  uuid NOT NULL REFERENCES student_profile(id),
  tutor_profile_id    uuid NOT NULL REFERENCES tutor_profile(id),
  status              engagement_status NOT NULL,  -- active | paused | ended
  origin              engagement_origin NOT NULL,  -- match | browse | rebook | admin
  source_proposal_id  uuid REFERENCES match_proposal(id),
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  ended_reason        text
);
```

**BetterHelp mode is then one index:**

```sql
-- Enforces "one active tutor per student". DROP THIS INDEX to become a marketplace.
CREATE UNIQUE INDEX engagement_one_active_per_student
  ON engagement (student_profile_id) WHERE status = 'active';
```

That is the entire cost of switching product angles at the data layer: one migration, no backfill, no query rewrites. Everything downstream (bookings, threads, notes) hangs off `engagement` or off `(student, tutor)` directly and works either way.

**Corollary for the UI track:** the assigned-match experience is a *routing and presentation* decision (show one proposal instead of a list), not a data decision. Keep it that way.

### 2.2 Identity, roles, and the parent case

The second-most-expensive mistake is conflating *the person who logs in*, *the person being tutored*, and *the account that pays*. Split them:

```sql
user                 -- anyone who can log in. Owned by Better Auth (+ session, account, verification tables).
  id, email, name, timezone (IANA), locale, status, created_at

role_assignment      -- a user can hold several roles; a tutor can also be a parent
  user_id, role      -- student | tutor | parent | admin

student_profile      -- the learner. NOTE: user_id is NULLABLE.
  id, user_id NULL REFERENCES user(id),
  display_name, age_band, timezone, locale, created_at

tutor_profile
  id, user_id NOT NULL, headline, bio, intro_video_url,
  status,            -- draft | pending_review | active | paused | suspended
  timezone (IANA), default_rate_minor, currency,
  stripe_account_id NULL

guardianship
  guardian_user_id, student_profile_id, relationship,
  is_payer bool, consent_granted_at, consent_scope, terms_version

billing_account      -- WHO PAYS. Separate from user. Stripe customer hangs off THIS.
  id, owner_user_id, stripe_customer_id, currency, country

billing_account_member
  billing_account_id, student_profile_id   -- one account can fund several children
```

**`student_profile.user_id` being nullable is a deliberate, cheap hedge.** A parent-managed 8-year-old may have no login at all (and under COPPA, arguably shouldn't). Making this column nullable costs two hours today; making it nullable after launch means auditing every query that joined through it. Ship it in migration #1 even if minors are out of scope at launch.

**The parent-pays-for-minor case falls out of this cleanly:** the parent has their own `user` row and their own login. `guardianship` grants scoped access to the child's `student_profile`. The `billing_account` is owned by the parent and funds the child. Nobody shares a password. The authorization question becomes "does an active guardianship edge exist from actor → this student profile?", which is one function in the data access layer.

**Actor vs. subject.** Every server action resolves an *actor* (the logged-in user) and a *subject* (the student profile being acted on), and checks the edge between them. Build this helper first:

```ts
// src/server/auth/actor.ts
requireActor()                                  -> Actor
requireStudentAccess(actor, studentProfileId)   -> 'self' | 'guardian' | 'admin'  (throws otherwise)
requireTutorSelf(actor, tutorProfileId)         -> void
```

### 2.3 Catalog: subjects and levels

```sql
subject        id, slug, name, parent_id NULL         -- tree: Maths > Algebra
level          id, slug, name, framework, ord         -- framework: uk_gcse | us_grade | ib | generic
tutor_subject  tutor_profile_id, subject_id,
               level_min_ord, level_max_ord,
               rate_minor NULL                        -- per-subject rate override
```

Use a **real taxonomy table, not free-text tags**, as the primary structure. Free-text is seductive at MVP and then you cannot filter, cannot build the browse UI, and cannot score matches. Add a free-text `keywords` column alongside it if you want the flexibility — but the join table is what matching queries.

`level` has a numeric `ord` inside a `framework` so "at least GCSE level" is a range comparison, not a set of magic strings. Cross-framework mapping (US grade 10 ≈ GCSE) is a lookup table you can add later.

### 2.4 Credentials and safeguarding gate

```sql
credential
  id, tutor_profile_id,
  type,                 -- degree | teaching_cert | dbs | wwcc | id_check | reference
  issuer, reference, issued_at, expires_at,
  verification_status,  -- pending | verified | rejected | expired
  verified_by_user_id, verified_at,
  document_asset_id     -- private storage, signed URLs only
```

**A tutor's bookability is derived, not stored as a loose boolean:** `status = 'active'` AND all *required* credential types are `verified` AND not expired. Compute it in one SQL view/function so there is exactly one definition. A nightly job flips tutors out of bookable when a background check lapses — this is a safeguarding requirement, not a nicety, and it is far cheaper to build now than to retrofit.

### 2.5 Matching records

```sql
intake_response
  id, student_profile_id, submitted_by_user_id, version,
  answers jsonb,                    -- raw, for replay
  -- plus normalized columns the matcher actually queries:
  subject_ids uuid[], level_ord int, budget_max_minor, preferred_langs text[],
  availability_mask bit(336),       -- 30-min buckets over a week, in student's tz
  submitted_at

match_run                           -- one per matching attempt. NEVER delete these.
  id, intake_response_id, algorithm_version,
  weights_snapshot jsonb, candidate_pool_size, duration_ms, created_at

match_candidate                     -- every tutor considered, not just the winner
  match_run_id, tutor_profile_id, rank, score, score_breakdown jsonb

match_proposal                      -- what was actually shown
  id, match_run_id, tutor_profile_id,
  status,                           -- proposed | accepted | declined_by_student | declined_by_tutor | expired
  shown_at, responded_at, expires_at, decline_reason
```

**`match_run` + `match_candidate` are the highest-leverage tables in the schema and cost almost nothing.** They are your only path to ever improving matching, your only way to answer "why did we show her that tutor?", and the training set for the learned ranker that might one day justify the Python service. Log the full candidate set with score breakdowns, not just the winner. Treat them as append-only.

### 2.6 Scheduling

```sql
availability_rule
  id, tutor_profile_id, weekday, start_local time, end_local time,
  timezone text,                    -- IANA, e.g. 'Europe/Vilnius'
  effective_from date, effective_to date NULL

availability_exception
  tutor_profile_id, date, kind,     -- block | extra
  start_local time, end_local time, timezone text

slot                                -- MATERIALIZED, rolling ~60 day window
  id, tutor_profile_id,
  starts_at timestamptz, ends_at timestamptz,
  state,                            -- open | held | booked
  generated_from_rule_id, hold_expires_at NULL

booking
  id, student_profile_id, tutor_profile_id, engagement_id NULL, slot_id,
  starts_at timestamptz, ends_at timestamptz,
  booked_in_timezone text,          -- what the student SAW, for receipts and disputes
  status,                           -- pending_payment | confirmed | cancelled | rescheduled
                                    -- | completed | no_show_student | no_show_tutor
  cancellation_policy jsonb,        -- SNAPSHOT at booking time, not a FK to a mutable policy
  supersedes_booking_id NULL,       -- reschedule chain
  created_at

session                             -- the live meeting, 1:1 with a confirmed booking
  booking_id, room_provider, room_id, room_url_expires_at,
  actual_start, actual_end, recording_asset_id NULL

session_participant_event           -- audit: who joined, when, from where
  session_id, user_id, event, at
```

**Reschedule is a new row + `supersedes_booking_id`, never a mutation.** You need the history for refunds, disputes, no-show policy, and safeguarding. Same for cancellation — status transitions are appended to an audit table, not overwritten silently.

**`cancellation_policy` is a snapshot.** If you change your refund policy in March, February's bookings must still be judged by February's rules. A FK to a mutable policy row silently rewrites history.

### 2.7 Timezones — how to model this properly

This is the classic pain source. The rules, in order of importance:

1. **Every instant is `timestamptz`.** Postgres stores UTC internally. Set the connection `TimeZone = UTC` explicitly so no environment-dependent behaviour creeps in.
2. **Store IANA zone IDs (`Europe/Vilnius`), never UTC offsets (`+02:00`).** An offset is a fact about one moment, not about a place. A tutor stored as "+02:00" is wrong for half the year.
3. **Recurring availability is stored as local wall-clock time + zone, never as UTC.** "Tuesdays 16:00–18:00 `Europe/Vilnius`" stays at 16:00 local across DST. If you normalize it to UTC at write time, the tutor's schedule silently shifts by an hour twice a year and they find out when a student doesn't show.
4. **Materialize rules into concrete `slot` rows** over a rolling window (60 days) in a nightly job. Two reasons: the availability query becomes a plain indexed range scan instead of recursive rule expansion per request, and **all DST logic lives in exactly one place** that you can unit-test to death.
5. **Handle the two DST edge cases explicitly in the expansion job**, and write down which you chose:
   - *Spring forward* — the local time doesn't exist (02:30 on the changeover day). Skip the slot.
   - *Fall back* — the local time occurs twice. Take the first occurrence. Document it.
6. **A booking stores both the UTC instant and `booked_in_timezone`.** Receipts, reminder emails, and dispute resolution all need "you booked 16:00 *your* time", and the student's profile timezone may change (they travel) after the booking.
7. **Store `ends_at` explicitly**, not just `duration_minutes`. A session spanning a DST boundary is otherwise ambiguous.
8. **Render in an explicit timezone, always.** Server-render times with a known zone rather than relying on implicit browser-local. Let users override their timezone in settings — students travel, and "my slots all moved" is a top support ticket otherwise.
9. **Library:** **Luxon 3.7.x** or **`@date-fns/tz` 1.5.x** (both current, both handle IANA correctly). The `Temporal` API is landing in runtimes and will eventually be the right answer — check whether your Node/browser targets support it natively before adopting; if not, don't ship a large polyfill just for elegance.
10. **Test it seriously.** Run CI with `TZ=Australia/Adelaide` (DST *and* a half-hour offset) so implicit-local bugs fail loudly. Unit-test slot expansion across both DST transitions in both hemispheres, plus a zone with no DST.

**Double-booking must be structurally impossible, not application-enforced:**

```sql
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    tutor_profile_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('pending_payment','confirmed'));
```

Application-level checks lose to concurrency. Let Postgres win it for you.

### 2.8 Messaging

```sql
thread
  id, engagement_id NULL, kind,     -- tutoring | support | admin
  created_at, last_message_at

thread_participant
  thread_id, user_id,
  role_in_thread,                   -- student | tutor | guardian_observer | admin
  can_post bool, joined_at, left_at NULL

message
  id, thread_id, sender_user_id,
  body text, redacted_body text NULL, flags jsonb,
  created_at, edited_at, deleted_at  -- soft delete only

message_read   message_id, user_id, read_at
attachment     id, message_id NULL, storage_key, mime, size_bytes, scan_status
```

**Threads have a participant *list*, not two fixed columns.** The moment a parent needs visibility into their child's conversation with a tutor — which is a likely safeguarding requirement, not a maybe — a `student_id`/`tutor_id` thread schema is dead. `guardian_observer` as a participant role costs nothing now.

Messages are **soft-deleted and admin-readable**. This is a safeguarding and dispute-resolution requirement, and it needs to be in your privacy policy from day one rather than bolted on.

### 2.9 Billing and payouts

```sql
subscription            -- only if the subscription angle wins
  billing_account_id, stripe_subscription_id, status, plan_code,
  current_period_start, current_period_end, included_sessions_per_period

order                   -- a charge event
  id, billing_account_id, kind,     -- session | subscription_invoice | package
  amount_minor, currency, status,
  stripe_payment_intent_id NULL, stripe_invoice_id NULL, created_at

ledger_entry            -- APPEND ONLY. The source of truth for who is owed what.
  id, account_kind,                 -- platform | tutor | billing_account
  account_ref uuid, direction,      -- debit | credit
  amount_minor, currency, reason,
  booking_id NULL, order_id NULL, payout_id NULL, created_at

payout
  id, tutor_profile_id, stripe_transfer_id,
  amount_minor, currency, period_start, period_end, status
```

**Build the ledger at MVP even while you pay tutors manually by bank transfer.** It's one table and an insert on two events (payment captured, session completed). Without it you cannot answer "what do we owe this tutor?" without reconstructing it from Stripe, and reconstruction after the fact is miserable. With it, switching to automated Connect payouts later is just changing *who executes the transfer*, not *how you compute it*.

### 2.10 Reviews, notes, progress

```sql
review        booking_id UNIQUE, author_user_id, tutor_profile_id,
              rating, body, status,   -- pending | published | hidden
              created_at

session_note  id, booking_id, author_user_id, body,
              visibility,             -- tutor_private | shared_student | shared_guardian
              created_at

learning_goal id, student_profile_id, subject_id, description,
              target_date, status
goal_progress goal_id, booking_id, note, rating, recorded_at
```

**`session_note.visibility` is a three-way enum from the start.** Tutors need private working notes; students need shared summaries; guardians paying the bill need progress visibility. Collapsing this to a boolean and splitting it later means re-classifying existing notes, which you cannot do safely or automatically.

### 2.11 Audit

```sql
audit_event   id, actor_user_id NULL, action, entity_type, entity_id,
              payload jsonb, ip inet, user_agent, created_at
```

Append-only. Write to it on: role changes, credential verification decisions, booking status transitions, refunds, message deletion, guardianship changes, admin impersonation. Required for both money disputes and safeguarding, and trivially cheap if you start now.

### 2.12 Summary of expensive-to-reverse decisions

| Decision | Chosen | Why it's hard to reverse |
|---|---|---|
| Student↔tutor cardinality | Many-to-many `engagement` + droppable partial unique index | Rewrites every tutoring query and needs a data migration under load |
| `student_profile.user_id` nullable | Nullable | Every join through it must be re-audited if changed later |
| Payer modeled as `billing_account` ≠ `user` | Separate entity | Stripe customer IDs get attached to the wrong entity; migrating them is manual |
| Money as integer minor units | `BIGINT` + currency | Float rounding errors are unrecoverable and legally messy |
| Availability as local time + IANA | Local + zone | UTC-normalized rules are lossy; the original intent is gone |
| Thread participants as a list | Join table | Adding a guardian to a 2-column thread means rebuilding messaging |
| Cancellation policy snapshotted | `jsonb` on booking | A policy FK silently rewrites the terms of past bookings |
| Note visibility 3-way | Enum | Re-classifying existing notes is unsafe to automate |
| Match runs logged | Append-only | You cannot retroactively generate training data |
| Stripe Connect adoption | See §3.6 | Every existing tutor must redo KYC |

---

## 3. Subsystem calls

### 3.1 Auth and session management — **BUILD on a library (Better Auth)**

**Recommendation: `better-auth` 1.7.x**, self-hosted inside the Next app, Postgres-backed sessions, Drizzle adapter, mounted at `app/api/auth/[...all]/route.ts`.

Why:
- Auth.js/NextAuth v5 is effectively in maintenance mode — security patches, no new feature work. Better Auth is where active development moved. Starting a greenfield project on a maintenance-mode library is a slow-motion migration.
- You need email/password, OAuth (Google — most parents have one), magic links, and email verification out of the box. Better Auth ships all of these plus 2FA and organizations if you need them later.
- Sessions live in *your* Postgres, which means the guardianship/roles authorization query is a plain join, not a call to someone's API.

**Why not Clerk (the main buy alternative):** Clerk is genuinely faster to integrate and its UI components are good. But (a) your MAU count triples because students, parents, *and* tutors all count as users, on a product where many users are low-value; (b) guardianship is a first-class domain concept here and modeling it inside someone else's user store means constant round-trips or webhook-synced shadow tables; (c) you'd end up mirroring users into Postgres anyway to do authorization joins. **Revisit Clerk if auth becomes a time sink in week 2** — it's a legitimate call, just not the default one.

**Architecture rules:**
- `proxy.ts` does coarse redirects only. **All authorization lives in the data access layer** (§2.2's `requireActor` / `requireStudentAccess`). Never trust a route-boundary check.
- Admin impersonation ("view as this user") is a genuinely useful support tool — build it early, and write every use to `audit_event`.
- Tutors and students in the same user table with `role_assignment`, not separate auth systems. A tutor may also be a parent.

### 3.2 Database and access layer — **Neon + Drizzle**

**Postgres on Neon.** The deciding feature is **database branching**: a branch per PR/preview deploy gives every pull request a real database with real (anonymized) data, which is worth more than any other single piece of dev infrastructure at this stage. Pair with a **local Postgres in Docker** for offline work — do not develop against a shared cloud DB.

*Supabase alternative:* strong if you want its bundled auth + storage + realtime. But you're not using its auth (Better Auth), its realtime is a smaller win than you'd think (§3.3), and its RLS-centric security model actively conflicts with a server-only data access layer in Next — you'd be maintaining authorization in two places (RLS policies *and* TS), which is the same duplication problem as §1.2. **Verdict: Neon.** (Neon was acquired by Databricks in 2025; the product hasn't changed, but glance at current pricing tiers before committing.)

**ORM: Drizzle.** `drizzle-orm` latest stable is **0.45.2**, with **1.0 currently in RC (`rc.4`)**. This is a real wrinkle and you should decide deliberately:

- Starting on 0.45.2 means a 1.0 migration within months.
- Starting on the 1.0 RC means riding an RC for a few weeks.
- **My call: start on the 1.0 RC line** for a greenfield project — it will very likely be stable before you have paying users, and the later migration is worse than the churn now. **Verify 1.0 has gone stable before you take real payments.**

Why Drizzle over Prisma: the matching engine wants hand-written SQL (window functions, scoring expressions, array overlap operators), and Drizzle lets you drop to SQL without leaving the type system. That's a product-driven reason, not taste. The Drizzle team joined PlanetScale in March 2026, so backing is solid.

**In fairness, this call is close now.** Prisma 7 (rust-free TS/WASM client, ~1.6MB vs the old 14MB engine, materially faster, much better serverless cold starts) closed most of the historical gap, and Prisma's migrations and Studio remain best-in-class. If your team already knows Prisma, taking Prisma 7.10 is defensible and you should not agonize.

**The hedge that actually matters:** commit **plain SQL migration files** (drizzle-kit generates them) to the repo. The schema is the durable asset; the ORM is a query builder you could replace in a painful-but-bounded week. Keep all DB access inside `src/server/modules/*/repo.ts` files so the surface area is known.

### 3.3 Realtime messaging — **BUY the transport, OWN the data**

Messages always persist in your Postgres. The only question is fanout.

**MVP: don't build websockets at all.** The core loop here is *asynchronous* messaging (BetterHelp's model), not a chat app. Poll an open thread every ~5 seconds from the client, and send an email notification on new message when the recipient isn't active. This is genuinely sufficient, takes an afternoon, and costs nothing.

**V1: Pusher Channels** (or Ably). Hosted, trivial to integrate, private channels authorized by a Next route handler that checks `thread_participant`. Ably has a better free tier and more features; Pusher is simpler. Either is fine.

**Explicitly avoid at this stage:**
- Postgres `LISTEN/NOTIFY` — it needs a persistent connection, which fights serverless and connection pooling.
- Self-hosted Socket.IO — that's the second deploy target we're avoiding (§1.2).
- Server-Sent Events from a Next route handler — workable but function-duration limits and connection accounting on serverless make it a trap at Vercel.

### 3.4 Live video and whiteboarding — **BUY, no debate**

**Video: Daily** (`@daily-co/daily-js` 0.92.x) **with Daily Prebuilt** for the MVP. The prebuilt iframe is roughly a one-day integration: create a room at booking confirmation, generate short-lived meeting tokens per participant, embed. ~10,000 free minutes to start.

Cost shape (verify current rates directly — pricing moves):
- **Daily / 100ms** — best economics and least work **under ~200k min/month**. Both have startup free tiers around 10k minutes. HIPAA on paid plans only.
- **LiveKit** — cheaper above roughly 200k–2M min/month; 2026 pricing has tiers at $0/$50/$500 plus enterprise, upstream bandwidth now free and downstream dropped to ~$0.12/GB. More integration work (you build the UI). **The right migration target, not the right starting point.**
- **Whereby Embed** — simplest of all, least control.
- **Zoom SDK** — only if your tutors already live in Zoom and demand it.

Rough sizing: 1,000 sessions/month × 60 min × 2 participants ≈ 120k participant-minutes — comfortably in the "just pay Daily" zone. Video is unlikely to be your largest line item before you have real revenue.

**Whiteboard: defer entirely at MVP.** Screen share covers most tutoring, and whiteboard-with-sync is a deceptively large project. For V1:
- **tldraw** — excellent product and React integration, but **check the license**: commercial use without the watermark requires a paid license. Verify current terms before building on it.
- **Excalidraw** — open source (MIT) and embeddable, but you own the collaboration/sync layer, which is the hard 80%.
- Or use whatever collaborative canvas your video vendor ships.

**Recording: do not record at MVP.** If you record, you are storing sensitive footage (potentially of minors) and you've acquired encryption, retention, deletion, access-logging, and two-party consent obligations. Instead, keep the **`session_participant_event` log** — who joined, when, for how long. That delivers most of the audit and dispute value for approximately none of the cost or risk.

### 3.5 Scheduling — **BUILD, carefully**

Booking is core product, so build it — but the modeling discipline in §2.6/§2.7 is non-negotiable.

**Phasing:**
- **MVP:** materialized slots, single-session booking, tutor availability entered by *you* via an admin form. No self-serve reschedule (handle by email). No calendar sync.
- **V1:** self-serve reschedule/cancel with a snapshotted policy, no-show handling, recurring weekly bookings, and a **read-only ICS feed** per user. The ICS feed is high value for low effort — one route handler emitting a `.ics` — and covers 80% of "it's in my calendar".
- **V2:** two-way Google Calendar sync via OAuth (watch channels, token refresh, conflict resolution). This is a genuinely large project — do not put it in V1.

**Buy alternative — Cal.com:** you can self-host it or use its platform API and skip building scheduling. Real option, and if you're time-starved it's worth a day's evaluation. My reservation is that the booking flow here is entangled with matching, engagements, payment holds, and the cancellation ledger, so embedding an external booker means constant impedance mismatch on your core surface. **Verdict: build, but if scheduling eats more than 2 weeks, reconsider.**

**No-shows:** a `booking.status` value plus a policy. Model the *money* consequence in the ledger (student charged, tutor paid partial, platform waives) rather than as ad-hoc refund logic. A sweeper job marks bookings `no_show_*` some hours after the end time if no participant events were recorded.

### 3.6 Payments — **Stripe. The Connect question is the real one.**

`stripe` (node) 22.x, `@stripe/stripe-js` 9.x. Checkout/Elements for card capture — never touch card data.

**The decision tree:**

| Scenario | Setup |
|---|---|
| You pay tutors through the platform (either product angle) | **Stripe Connect Express.** Tutors onboard through Stripe-hosted KYC; identity verification, tax forms (1099-K in the US, DAC7 in the EU), and compliance are Stripe's problem. |
| Tutors are your employees/contractors paid off-platform | Plain Stripe (subscriptions or payment intents). You're merchant of record. Payroll is a separate, non-architectural problem. |
| MVP with <20 hand-picked tutors | **Plain Stripe + manual payouts** (bank transfer/Wise), *but keep the ledger* (§2.9). |

**The expensive-to-reverse part:** adopting Connect later means **every existing tutor must go through KYC onboarding again**. That's a re-activation campaign with meaningful drop-off, and the cost scales linearly with tutor count. So:

> **Rule: stay on manual payouts only while tutor count is small enough to email individually (~20). Adopt Connect Express before you cross that.** Adopting it at tutor #15 is a week; at tutor #150 it's a quarter and you lose tutors.

**Charge structure — use separate charges and transfers, not destination charges.** Reasons specific to this product:
- Under the subscription angle, one payment may cover sessions later delivered by more than one tutor, or by a tutor not yet known at payment time. Destination charges require naming the recipient up front.
- You want to **hold funds and transfer on session completion + a clearing window**, so a chargeback or a no-show dispute doesn't arrive after the money has left. Model the hold as a `pending` ledger entry that becomes `released` on transfer.
- Platform fee is then explicit in the ledger rather than implicit in `application_fee_amount`.

**Both product angles, concretely:**
- *Marketplace:* `PaymentIntent` per booking → hold → `Transfer` to the tutor's connected account N days after completion.
- *Subscription:* Stripe `Subscription` on the `billing_account` → each billing period credits N included sessions → each completed session debits the entitlement and accrues a tutor payable in the ledger → periodic batched `Transfer`.
  Note the entitlement/credit model is the piece people underestimate: "4 sessions/month, do unused ones roll over?" is a product decision with real ledger consequences. **Ask the founder.**

**Webhooks:** the Stripe webhook route handler must be **idempotent** (store `stripe_event_id`, ignore duplicates) and must do the minimum work synchronously — enqueue an Inngest job for the rest. Verify signatures. This route is the highest-consequence code in the app; it gets integration tests.

**Also flag, don't solve:** Stripe Tax; tutoring is VAT-exempt or reduced-rate in several jurisdictions; marketplace facilitator rules. Get an accountant's input before launch, not after.

### 3.7 The matching engine — **plain SQL scoring. Embeddings are premature.**

Be blunt: **at launch you will have fewer than 100 tutors.** A vector index over 100 rows is a party trick. It is resume-driven complexity that will also make your matches *worse*, because you'll have no way to explain or tune them.

**The launch design:**

1. **Hard filters (SQL `WHERE`)** — reduce to eligible candidates. Subject and level overlap, availability intersection (student's `availability_mask` AND tutor's materialized open slots), language, price band, tutor bookable, capacity not exceeded, no prior block between the pair.
2. **Soft scoring (SQL expression, weights from a config row)** — e.g.:
   ```
   score = w_avail  * availability_overlap_hours_normalized
         + w_level  * level_fit
         + w_price  * price_fit
         + w_style  * teaching_style_overlap
         + w_rating * bayesian_rating
         + w_load   * inverse_current_load        -- spread demand across supply
         + w_fresh  * new_tutor_boost             -- cold-start: new tutors need first sessions
   ```
3. **Tie-break deterministically**, and log everything to `match_run` / `match_candidate`.
4. **Return top N.** Show 1 (BetterHelp mode) or 3–5 (marketplace mode) — a config flag, same engine. Under assigned-match, always include a "request a different match" action; that button's click-through rate is your cheapest signal about which product angle is right.

**Weights live in a database config row, not in code.** You will re-tune weekly at first, and a deploy per tune is friction you'll stop paying, which means you'll stop tuning.

**Two things that are *not* premature and cost almost nothing:**
- **Logging every run with full score breakdowns** (§2.5). Without it you're flying blind forever.
- **The `load` and `new_tutor_boost` terms.** Marketplace cold-start — new tutors getting zero matches and churning — is a more likely failure mode than poor match quality.

**When embeddings genuinely earn their place:** you have a free-text intake field ("describe what your child is struggling with") where keyword and taxonomy matching demonstrably fails, **and** >1,000 tutors. Then add **`pgvector` in the same Postgres**, generate embeddings via an HTTP call from Node, and use vector similarity as *one more term in the same weighted score* — never as the whole ranker, because you lose explainability and the ability to guarantee hard constraints. **Still no Python.**

### 3.8 Background jobs — **Inngest**

`inngest` 4.x. Reasons: works on serverless (no persistent worker), durable multi-step functions with automatic retries, built-in cron, a local dev server, and a free tier that comfortably covers MVP volume. **Trigger.dev is an equally reasonable pick** if you prefer its model.

**Avoid BullMQ at this stage.** It needs a persistent Redis *and* a long-running worker process — a second deploy target and a second runtime to operate, which is exactly the overhead §1 argues against.

Jobs you will need almost immediately:
- Nightly slot materialization (rolling 60-day window)
- Session reminder emails (24h, 1h before)
- Post-session: mark complete, request review, release tutor payable
- No-show sweeper
- Credential expiry check → un-book affected tutors
- Stripe webhook follow-up work
- Match proposal expiry
- Weekly digest / re-engagement

### 3.9 File and media storage — **buy**

- **Vercel Blob** (`@vercel/blob` 2.x) if you're on Vercel — simplest path, presigned client uploads.
- **Cloudflare R2** if media volume grows — no egress fees, which matters if you ever store recordings.
- **UploadThing** is a fine speed-run for the upload UX specifically.

**Non-negotiable:** credential documents (ID, DBS/background checks) and any session artifacts go in a **private bucket with short-lived signed URLs**, never public. Run attachments through a virus scan before they're downloadable (`attachment.scan_status`) — you are letting strangers send files to children.

### 3.10 Email and notifications — **buy**

**Resend** (`resend` 6.x) + **React Email** (`react-email` 6.x). Transactional only at MVP: verification, magic link, booking confirmation, reminders, new message, receipt, password reset. Templates as React components keeps them in the type system.

Deferred: web push, SMS (Twilio — add only if reminder emails demonstrably fail to prevent no-shows; SMS reminders are the standard fix and worth it once you have the data), in-app notification center, digests.

Set up SPF/DKIM/DMARC on day one. Booking confirmations landing in spam is a silent conversion killer.

---

## 4. Hosting, environments, observability, testing

### 4.1 Day one (genuinely worth it)

| Thing | Choice | Why now |
|---|---|---|
| Hosting | **Vercel** | Zero-config for Next 16, preview deploys per PR |
| Database | **Neon**, branch per preview | A real DB per PR is the highest-value dev infra you can buy |
| Local | Docker Compose: Postgres + Mailpit | Never develop against shared cloud state |
| CI | GitHub Actions: typecheck, lint, `vitest`, migration dry-run | Cheap, catches the dumb stuff |
| Errors | **Sentry** (`@sentry/nextjs` 10.x) | You will not read logs; you will read Sentry |
| Product analytics | **PostHog** | **Intake completion rate is the core metric of this product.** Instrument the funnel before launch or you learn nothing from it. |
| Secrets | Vercel env vars, 3 environments | — |
| Backups | Neon PITR | **Test a restore once before launch.** An untested backup is not a backup. |

**Environments: three.** Local, Preview (per-PR, Neon branch, Stripe test mode, Daily dev domain), Production. **Do not build a separate long-lived staging environment** — preview deploys with real database branches cover it better and cost nothing to maintain.

### 4.2 Defer

Terraform/Pulumi · Kubernetes · multi-region · read replicas · a service mesh · APM beyond Sentry tracing · load testing · a feature-flag SaaS (use a DB table + a `flag()` helper; migrate to PostHog flags when you actually need targeting) · a design system package · a monorepo (see §5.4) · SOC 2 (until a school district asks).

### 4.3 Testing — the minimum that actually pays

**Four unit test suites, high value, day one:**
1. **The matching scorer.** Pure function, trivially testable, directly protects your core value prop.
2. **Slot expansion and timezone math.** Highest bug density in the whole system. Test both DST transitions, both hemispheres, a half-hour-offset zone, and a no-DST zone.
3. **Ledger arithmetic.** Money that doesn't reconcile is unrecoverable trust damage.
4. **Cancellation/refund policy evaluation.** Pure decision logic, many edge cases.

`vitest` 5.x. Run CI with `TZ=Australia/Adelaide` to smoke out implicit-local-time assumptions.

**Integration tests against a real Postgres** (Docker locally, a Neon branch in CI) for: the booking transaction (prove the exclusion constraint prevents double-booking under concurrency), and Stripe webhook idempotency (replay the same event twice, assert one ledger entry).

**E2E: 2–3 Playwright paths only** (`playwright` 1.63.x), but do these *early* despite the "later" instinct, because they cover money:
- signup → intake → match → book → pay → confirmation
- tutor login → see booking → join room
- reschedule → refund calculation

**Skip:** component tests, snapshot tests, coverage targets. They cost more than they return at this stage.

### 4.4 Lock-in check

Vercel lock-in here is mild: stay in the Node runtime, avoid proprietary APIs beyond Vercel Blob (swappable for R2 in a day), and the Build Adapters API gives an exit path if you ever need to self-host. **Revisit when the Vercel bill passes ~$500/mo** — that's roughly when a container on Railway/Fly starts making financial sense, and by then you'll know your actual traffic shape.

---

## 5. Phased build plan

### 5.1 Phase 0 — Foundation (2–3 days)

Next 16 app scaffolded · Drizzle + Neon + first migration (including `guardianship` and nullable `student_profile.user_id` even if unused) · Better Auth with email/password + Google · Vercel deploy · Sentry · CI green · Docker Compose for local.

### 5.2 Phase 1 — Thin-slice MVP (~4–6 weeks)

**The slice: a student completes intake, is matched to a tutor, books and pays for one real 1:1 session, both join a video room, the tutor writes a note, and the two can message.**

That's the smallest thing that delivers real value end to end — it proves the match is worth paying for, which is the only hypothesis that matters.

**In scope:**
- Intake questionnaire → `intake_response` (normalized, not just JSON)
- SQL matching engine with full `match_run` logging; show 1 tutor + a "request a different match" button
- Tutor profile pages (read-only, populated by you)
- Slot-based booking, single session, one currency, one price
- Stripe Checkout → `pending_payment` → webhook → `confirmed`
- Daily Prebuilt room created on confirmation, short-lived tokens
- Threaded messaging with polling + email notification
- Session notes with the 3-way visibility enum
- Transactional email (Resend)
- Minimal admin: create tutors, enter availability, verify credentials, view match runs

**Deliberately faked or manual:**
- **Tutor onboarding** — you hand-onboard via the admin form. (This is also better product discovery.)
- **Tutor payouts** — manual bank transfer, *but the ledger records everything*.
- **Reschedule/cancel** — handled by email to support.
- **No** subscriptions, reviews, recurring bookings, calendar sync, whiteboard, real-time sockets, parent accounts (unless minors are in scope — then guardianship is in MVP, see §6).

**Exit criterion: 10 real paid sessions completed by strangers.** Not signups. Sessions.

### 5.3 Phase 2 — V1 (~8–10 weeks after)

Tutor self-serve onboarding + **Stripe Connect Express KYC** + automated payouts on the clearing window · self-serve reschedule/cancel with snapshotted policy + no-show handling · reviews · recurring weekly bookings · ICS feed · real-time messaging (Pusher) · guardian accounts + consent records + guardian thread visibility · credential verification workflow with expiry job · proper admin console · subscription plan behind a feature flag · PostHog funnel instrumentation · Playwright money-path suite.

### 5.4 Deliberately deferred

Whichever of marketplace-browse / assigned-match didn't launch · embeddings matching · two-way Google Calendar sync · whiteboard · session recording · group sessions · native mobile apps · multi-currency and i18n · tutor analytics dashboards · AI lesson summaries · referral program · a monorepo (a single Next app is right until there's a second deployable; extracting to Turborepo later is a day).

### 5.5 Repo structure

```
tutor-helper-finder/
├── AGENTS.md
├── docker-compose.yml              # postgres + mailpit
├── drizzle.config.ts
├── next.config.ts
├── db/
│   ├── schema/
│   │   ├── identity.ts             # user, session, role_assignment, guardianship, billing_account
│   │   ├── catalog.ts              # subject, level, tutor_subject, credential
│   │   ├── matching.ts             # intake_response, match_run, match_candidate,
│   │   │                           #   match_proposal, engagement
│   │   ├── scheduling.ts           # availability_rule, availability_exception, slot,
│   │   │                           #   booking, session
│   │   ├── messaging.ts            # thread, thread_participant, message, attachment
│   │   ├── billing.ts              # subscription, order, ledger_entry, payout
│   │   ├── content.ts              # session_note, review, learning_goal
│   │   ├── audit.ts
│   │   └── index.ts
│   ├── migrations/                 # generated SQL, COMMITTED — the durable asset
│   └── seed.ts
├── src/
│   ├── proxy.ts                    # Next 16 (was middleware.ts). Coarse redirects ONLY.
│   ├── app/
│   │   ├── (marketing)/            # public, cacheable
│   │   ├── (auth)/
│   │   ├── (student)/              # intake, match, bookings, messages
│   │   ├── (tutor)/                # availability, bookings, notes, earnings
│   │   ├── (admin)/
│   │   └── api/
│   │       ├── auth/[...all]/route.ts
│   │       ├── webhooks/stripe/route.ts     # idempotent, signature-verified
│   │       ├── webhooks/daily/route.ts
│   │       ├── inngest/route.ts
│   │       └── calendar/[token]/route.ts    # ICS feed
│   ├── server/
│   │   ├── auth/                   # actor.ts — requireActor, requireStudentAccess
│   │   ├── db/                     # client, transaction helper
│   │   ├── modules/
│   │   │   ├── identity/
│   │   │   ├── matching/           # ←←← THE EXTRACTION SEAM (§1.4)
│   │   │   │   ├── types.ts        # future wire contract
│   │   │   │   ├── candidates.ts   # ONLY file here that touches the DB
│   │   │   │   ├── features.ts     # pure
│   │   │   │   ├── score.ts        # PURE. no I/O, no ORM, no clock.
│   │   │   │   ├── weights.ts      # loaded from DB config
│   │   │   │   └── index.ts        # runMatch() — the only public export
│   │   │   ├── scheduling/         # slots.ts, timezone.ts, availability.ts
│   │   │   ├── booking/
│   │   │   ├── billing/            # stripe.ts, ledger.ts, policy.ts
│   │   │   ├── messaging/
│   │   │   └── notes/
│   │   ├── jobs/                   # inngest functions
│   │   └── email/                  # react-email templates
│   ├── components/
│   ├── lib/
│   └── styles/
├── tests/
│   ├── unit/                       # scorer, timezone, ledger, policy
│   ├── integration/                # booking concurrency, stripe webhook idempotency
│   └── e2e/                        # 3 playwright paths
└── .github/workflows/ci.yml
```

Each `modules/*` directory holds `repo.ts` (all DB access), `service.ts` (business logic), `actions.ts` (server actions, which do authz then delegate). That layering is what makes the matching extraction a one-week job instead of a rewrite.

---

## 6. Minors (K-12) — architectural implications

**This scope decision isn't mine, but it has the largest architectural blast radius of any open question.** If minors are in scope, these are not features you add later:

1. **`student_profile` without a `user`** — a parent-managed young child may have no login at all (and under COPPA arguably shouldn't). Nullable `user_id` in migration #1. *Cost now: 2 hours. Cost later: auditing every join in the codebase.*
2. **Guardianship + versioned consent records** — who consented, when, to what scope, under which version of your terms. Regulators ask for exactly this.
3. **Age band captured at intake**, gating the entire flow: which tutors are eligible, whether a guardian must approve the booking, whether guardian thread visibility is on by default.
4. **Background checks as a hard bookability gate** — DBS (UK), WWCC (AU), state checks (US) modeled as `credential` rows with expiry, plus a job that removes tutors from availability when a check lapses. Retrofitting this means a period where unchecked adults had access to children, which is not a bug you can apologize for.
5. **Guardian visibility into messaging** — `thread_participant.role_in_thread = 'guardian_observer'`. This is why §2.8 uses a participant list rather than two columns.
6. **Off-platform contact leakage** is both a revenue leak and a safeguarding risk. MVP mitigation: regex-scan messages for phone numbers and emails, populate `message.redacted_body`, flag for admin review. Cheap, and you'll want the flagging infrastructure anyway.
7. **Recording** — if safeguarding policy demands recorded sessions, you've acquired encrypted storage, retention schedules, deletion workflows, access logs, and two-party consent. **Recommendation: don't.** The `session_participant_event` log gives most of the audit value at a fraction of the cost and risk. If a school contract later requires recording, price it as a real project.
8. **Deletion vs. retention tension** — GDPR/CCPA erasure requests conflict with append-only audit and legally-mandated financial retention. Design this *before* you have users: deletion = pseudonymize the `user` row, retain financial and safeguarding records under a documented lawful basis. Decide it once, write it down.
9. **Jurisdiction:** COPPA (US, under 13) · GDPR age of digital consent (13–16, varies by member state) · FERPA (only if you contract with schools — probably not at first) · UK safeguarding regimes if working with schools. **This needs a lawyer's input, not an architect's guess.** Flagging it, not solving it.

---

## 7. Risk register

| # | Risk | Likelihood | Hedge (and its cost) |
|---|---|---|---|
| 1 | Product angle flips to marketplace after building assigned-match | **High** | Many-to-many `engagement` + a droppable partial unique index. Never `student.assigned_tutor_id`. **Cost: zero.** |
| 2 | Stripe Connect retrofit forces every tutor through KYC again | **High** | Adopt Connect Express before tutor #20; until then cap tutor count and pay manually, but keep the ledger. **Cost: ~1 week if done early, a quarter + tutor churn if late.** |
| 3 | Timezone/DST bugs cause missed sessions | **High** | Local-time + IANA storage, materialized slots, one tested expansion path, `TZ=Australia/Adelaide` in CI. **Cost: a day of tests.** |
| 4 | Double-booking under concurrency | Medium | Postgres `EXCLUDE USING gist` constraint, not app logic. **Cost: 3 lines of SQL.** |
| 5 | Matching quality is bad and you can't tell why | **High** | Log `match_run` + `match_candidate` with score breakdowns from day one; track proposal accept rate and 2nd-session retention. **Cost: one table and an insert.** |
| 6 | Premature split to FastAPI taxes every feature | Medium | The seam and the four written triggers in §1.4. Require someone to name a fired trigger. **Cost: zero.** |
| 7 | Drizzle 1.0 RC churn, or ORM regret generally | Medium | Committed plain-SQL migrations; all DB access confined to `repo.ts` files; go to 1.0 stable before taking real payments. **Cost: discipline.** |
| 8 | Minors scope arrives late and forces rework | Medium | Ship nullable `student_profile.user_id` + `guardianship` + participant-list threads in migration #1 regardless. **Cost: ~2 hours.** |
| 9 | Chargeback or dispute after tutor was already paid | Medium | Hold transfers until N days post-completion; `pending` → `released` ledger states. **Cost: one enum.** |
| 10 | Messaging becomes a safeguarding liability | Medium | Persist everything, soft-delete only, admin-readable, redaction flag from MVP; state it in the privacy policy. **Cost: small.** |
| 11 | Tutor supply is the real bottleneck, not software | **High** | Build admin/ops tooling for manual tutor onboarding *before* self-serve. It's 10x cheaper and you need it permanently. **Cost: negative — it saves time.** |
| 12 | Vercel bill or lock-in bites at scale | Low | Node runtime only, no proprietary APIs beyond Blob, Build Adapters as the exit. Revisit at ~$500/mo. **Cost: zero.** |
| 13 | Notes/messages leak between parent, student, tutor | Medium | Single `requireStudentAccess` chokepoint; authz never in `proxy.ts`; integration test per role pair. **Cost: a day.** |

---

## 8. Assumptions made, and decisions needed from the founder

### 8.1 What I assumed (revisit if wrong)

- 1:1 tutoring, not group or cohort classes. *(Group changes scheduling substantially and is the strongest genuine argument for a Python constraint solver.)*
- Single country, single currency at launch.
- Tutors are independent contractors, not employees.
- Sessions are remote-only (no in-person matching, which would add geo and a whole different safety model).
- Under 1,000 tutors within the first year.
- No school/district contracts at launch (which would bring procurement, SSO, FERPA, and SOC 2).

### 8.2 Decisions I need

1. **Assigned match or marketplace browse at launch?** — Follow this doc and it's a UI decision plus one index, not a schema decision. But it drives what the UI track builds first, so pick a default.
2. **Are minors in scope at launch?** — The single largest scope lever (§6). Yes means guardianship, consent, and background-check verification are *in* the MVP.
3. **Subscription, pay-per-session, or both?** — Affects Stripe setup and the entitlement model. If subscription: **do unused included sessions roll over?** That question has real ledger consequences.
4. **Do you pay tutors through the platform at launch?** — Yes → Connect Express in the MVP. No → manual payouts, and hard-cap tutor count until you switch (risk #2).
5. **Which country and currency?** — Multi-currency is expensive and mostly unnecessary early.
6. **Are tutors sellers or your contractors?** — This is a legal/tax question (merchant of record, marketplace facilitator rules, 1099-K/DAC7) with direct architectural consequences. Needs an accountant before launch, not after.
7. **Must sessions be recorded?** — If yes, it's a real project with storage, retention, consent, and access-control costs; price it explicitly rather than assuming it's a toggle.

---

## 9. Version reference (verified against npm/PyPI on 2026-09-18)

| Package | Latest | Note |
|---|---|---|
| `next` | 16.3.5 | `middleware.ts` → `proxy.ts`, Node runtime default, Turbopack default |
| `react` / `react-dom` | 19.3.0 | |
| `typescript` | 7.0.2 | **7.x is the native-port compiler.** 6.0.3 is the last of the prior line. Verify your ESLint/Drizzle/Next toolchain is happy on 7 before adopting; pin to 6.0.3 if not. |
| `drizzle-orm` | 0.45.2 stable; **1.0.0-rc.4** on `rc` | See §3.2 — I recommend the 1.0 line for greenfield, confirm stable before launch |
| `drizzle-kit` | 0.31.10 | |
| `@prisma/client` | 7.10.0 | The credible alternative; rust-free, much improved |
| `better-auth` | 1.7.5 | Core API stable; **plugin APIs still move — pin exact versions and read release notes** |
| `next-auth` | 4.24.15 / Auth.js v5 | Maintenance mode — don't start here |
| `stripe` | 22.6.2 | |
| `@stripe/stripe-js` | 9.16.0 | |
| `tailwindcss` | 4.3.3 | |
| `zod` | 4.6.5 | |
| `@tanstack/react-query` | 5.103.1 | Only for client-side polling; Server Components cover most fetching |
| `inngest` | 4.20.0 | |
| `resend` / `react-email` | 6.28.1 / 6.9.5 | |
| `@daily-co/daily-js` | 0.92.2 | |
| `livekit-client` | 2.22.3 | Migration target at scale |
| `luxon` | 3.7.2 | or `@date-fns/tz` 1.5.0 |
| `rrule` | 2.8.1 | Only if you need full RRULE; weekday+time rules are simpler and usually enough |
| `@vercel/blob` | 2.8.0 | |
| `vitest` | 5.0.1 | |
| `playwright` | 1.63.0 | |
| `@sentry/nextjs` | 10.75.0 | |
| `pusher-js` / `ably` | 8.6.0 / 2.28.0 | V1, not MVP |

*(Not recommended, listed for the record: `fastapi` 0.141.1, `sqlalchemy` 2.0.54, `pydantic` 2.13.5 — the stack you'd reach for if a §1.4 trigger fires.)*

**Caveats on currency:** these are npm/PyPI `latest` tags as of today, which is authoritative for version numbers but not for ecosystem readiness. The two I'd actually verify before committing are **TypeScript 7** (toolchain compatibility) and **Drizzle 1.0** (stable release timing). Pricing figures for Daily/LiveKit and free-tier limits for Neon are from secondary sources and move frequently — check the vendors' own pages before budgeting.
