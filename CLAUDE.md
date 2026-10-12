# Tutor Helper Finder

Course-scoped peer tutoring for college students, launching on a single campus
(University of Alabama). A student picks the course they're struggling in, sees the
tutors who already took *that course* — ideally under *that professor* — and books a
package of sessions anchored to their next exam.

The wedge is course-level specificity: a tutor who aced MATH 125 under a given
instructor knows the real exams, the grading style and the curve. That is not
something a generalist "calculus tutor" marketplace can offer.

**Status: pre-MVP.** Scaffolded, no features built. See `docs/decisions.md` for what
is settled and what is still open — read it before making product-shaped choices.

## Stack

- **Next.js 16 (App Router) + React 19 + TypeScript** — the whole application
- **Tailwind 4**
- **Postgres + Drizzle** — Neon in deployed environments (branch-per-PR), local Postgres for dev
- **Better Auth** — self-hosted
- **Stripe Connect Express** — tutor payouts

**No Python service.** Matching at this scale is a weighted SQL query; embeddings, if
ever needed, run through pgvector in the same database. The cost of a second service
is duplicated authorization logic in two languages and two migration tools over one
schema. If matching is ever extracted, the seam is `src/server/modules/matching/`:
keep `score.ts` pure (no I/O, no ORM, no clock) and `candidates.ts` the only file that
touches the database.

**Next 16 is newer than most models' training data.** `AGENTS.md` (generated and
re-added by `next dev`) says to read the bundled guides in `node_modules/next/dist/docs/`
before writing framework code rather than relying on recalled Next.js conventions.
That applies here — App Router APIs have moved.

## Commands

```bash
npm run dev              # dev server
npm run build            # production build
npm run lint             # eslint
npm run typecheck        # tsc --noEmit
npm run db:generate      # drizzle-kit: generate migration from schema
npm run db:migrate       # drizzle-kit: apply migrations; a remote DB is refused unless HEAD == origin/main
npm run db:studio        # drizzle-kit: browse data
npm run db:seed          # idempotent local campus: courses, professors, exams, tutors
npm run db:demo          # re-runnable: drives the real functions to a populated session board
npm run db:check-money   # database-only money invariants per campus; exits 1 on any violation
```

Production migrations are automatic: `.github/workflows/migrate.yml` runs `db:migrate` on
every push to main using `DATABASE_URL_UNPOOLED` (Neon's direct URL; pgbouncer breaks the
migrator). Vercel Deployment Checks must list its `migrate` job, or new code can go live
before its tables exist. Create the GitHub Environment `production`, limit its deployment
branches to `main`, and put `DATABASE_URL_UNPOOLED` there, not in repo secrets.

The deadlines in the product (12h request expiry, 24h confirmation window, term-end
refunds) are only as accurate as the sweep that enforces them. `GET /api/cron` runs it,
guarded by `CRON_SECRET` and scheduled by `.github/workflows/cron.yml`
(Vercel's free tier caps crons at once a day, which is useless for a 12h deadline). The reads call the same sweeps
opportunistically, so nothing breaks without a scheduler — deadlines just drift until
someone loads a page. Locally:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron
```

`db:seed` and `db:demo` run under `--import tsx`, not plain `node`: Node's type
stripping uses ESM resolution and `schema.ts` imports `./auth-schema` without an
extension. The project is not ESM either, so top-level `await` does not transform —
both scripts wrap their body in `main()` for that reason.

## Structure

```
src/
  app/               # routes (App Router)
  server/
    db/              # drizzle schema + client
    modules/         # domain logic, one directory per bounded concern
      matching/      # score.ts must stay pure — see extraction seam above
docs/
  decisions.md       # decision record: settled, open, rejected
  research/          # source analysis from the design phase (6 docs, ~330KB)
```

## Invariants

These are expensive to reverse. Do not violate them without updating
`docs/decisions.md` first.

**`institution_id` on every campus-scoped table.** Expansion is campus-by-campus and
the tables were built for it on day one. A query that forgets this tenant key leaks
across campuses silently.

**Never key on the course code string.** Course codes get renumbered between terms.
The durable entity is `course`; `course_code_alias` carries term validity windows.
Tutor history and quality scores attach to `course` — never to a section, offering or
code string — or a renumbering forks a tutor's record.

**`professor` is a first-class field, not a profile detail.** An instructor change
invalidates the entire value proposition, so the system has to know about it.

**`(tutor, course)` is the core relationship, not `tutor`.** Someone can be excellent
at Calc I and mediocre at Organic. Ratings and ranking are per-course, and they are two
different things. The **public rating** — star average and count, per course and
overall, once past its threshold (`docs/decisions.md`, Ratings) — may cross to the
client. The **ranking score** and every input to it — smoothed posteriors, the renewal
term, sample counts, weights, and any rating below its threshold — are hidden, and
hidden means **stripped server-side before anything crosses into a client component** —
a server component serialises its props into the RSC payload, so a value that is merely
never rendered is still one "view source" away from being public. Map the scored row
down to the narrow shape the card displays, and apply rating thresholds before that
mapping. The test for any field added to that shape: *is it a fact about the pair or a
public rating past its threshold, or is it the ranker's arithmetic?* A professor name, a
term, a grade and "4.7 · 12 ratings" are the student's to see; a smoothed posterior, a
decayed recency weight, a renewal rate or a below-threshold count is how the deck was
ordered, and is not.

**A user can be both tutor and student.** On a peer campus this is routine, not an
edge case. Keep the user/profile split and keep the score histories separate.

**Money is stored as integer minor units.** Never floats.

**Reliability is timestamped facts only** — attended, late-cancelled, no-showed,
payment failed. Never a subjective read, never anything that proxies for academic
ability, and never surfaced as a visible score or badge on either side. Consequences
are expressed as platform mechanics (deposit required, fewer parallel requests) and
must always be recoverable. See `docs/decisions.md` for the reasoning; this one is a
product principle, not a preference.

**A package purchased up front is deferred revenue, not income.** Recognized revenue
derives from the session ledger; the Stripe balance is float. Tutor pay is held until
earned.

## Conventions

- Server-side logic lives in `src/server/`, not in route handlers
- Validate external input with Zod at the boundary
- Prefer server components; reach for `"use client"` only where interaction requires it
- A rule shared by a server module and a client form (eligible grades, availability
  window validation) lives in its own module that imports nothing. The bundler follows
  the import graph, not the symbol, so re-exporting it from a file that imports `db`
  leaves the trap armed and the build fails on `fs`/`net`/`tls`
- DRY - Don't repeat yourself
- KISS - Keep it simple stupid
- Chill with the comments, 95% of what i see isn't needed

## Rules by area

**Payments.** The ledger is the source of truth; the Stripe balance is float.
- Every Stripe call goes through the gateway in `billing/stripe.ts`, which has a real and a fake driver. Tests and CI use the fake and make zero Stripe calls.
- A redirect back from Checkout never proves payment. Only a verified webhook, or a sweep that asks Stripe, fulfils a purchase.
- Webhooks verify their signature and are idempotent: events repeat and arrive out of order.
- Every create call sends an idempotency key.
- Never call Stripe while holding a row lock. Read and lock, commit, call Stripe, then record the result.
- A refund never claws back pay a tutor has earned (`docs/decisions.md`).
- Stripe metadata carries `institution_id`.
- Agents never handle live keys. Test keys live only in `.env.local` and Vercel Preview, and the user sets them.

**Background work.**
- Deadlines and anything time-based run in the sweep behind `GET /api/cron`, never in a new scheduler.
- Email goes through `src/server/modules/notifications/`. A sent-at timestamp or a unique constraint makes sure a re-run sweep never sends twice.
- Messages stay within a campus and between parties who already share a request or package. No cold messages.
- Message content never feeds reliability, matching or any score.
- Start with Postgres and the sweep. Add a real-time transport only with a stated reason the simpler design fails. No second service.

**Database and migrations.** `migrate.yml` migrates prod before Vercel promotes the deploy, so the old code runs against the new schema for a while.
- Keep migrations additive. Renames, drops and `NOT NULL` without a default go through add, copy, then drop later.
- Generate migrations with `npm run db:generate`; never hand-edit a snapshot or the journal. The exception is renaming an enum value: use `drizzle-kit generate --custom` with a hand-written `RENAME VALUE`, because a plain generate drops and recreates the type.
- A value added with `ALTER TYPE … ADD VALUE` cannot be used by another migration in the same push. Merge enum-adding changes on their own.
- A new unique index on a table that already has data needs a duplicate-count query run against prod before merge. One duplicate fails the migrate job and holds the deploy.
- When two open branches carry the same migration number, the second to merge regenerates its migration on top of main.
- `db:seed` stays idempotent. Fixture people are plus-aliases of `SEED_INBOX`, never addresses on a real campus domain.

**UI.**
- Author screens at 390px wide first, then scale up.
- Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code.
- Match the copy voice: plain, direct, second person.

## Working on this repo

Work runs under pstack's `/poteto-mode`. Use one branch and one PR per item. Items with open product or money questions get a written proposal the user approves before anyone builds. Settled decisions are recorded in `docs/decisions.md`.

Before calling a branch ready to merge:
- Run typecheck, lint and `npm test`, plus `db:check-money` for anything that touches money.
- Run the build the way CI does. Extract the commit into a scratch directory (`git archive HEAD | tar -x -C <dir>`), copy `node_modules` (a symlink breaks Turbopack), then run `env -u DATABASE_URL -u STRIPE_SECRET_KEY -u STRIPE_WEBHOOK_SECRET npm run build` there. A build in a checkout reads `.env.local` and hides module-level database access, which then fails CI with `DATABASE_URL is not set`. Build Drizzle query builders inside functions; `alias()`, conditions and `sql` fragments are fine at module level.
- An independent reviewer checks the final commit. A commit added after review needs another look.
- State the result of the required GitHub check, or say it could not be seen.

Who merges:
- pstack may merge a PR itself (`gh pr merge --merge`) only when all of these hold: `npm run merge-gate -- <PR>` exits 0, an independent review passed on the final commit, and `gh pr checks` is green on that commit.
- The user merges anything `merge-gate` flags: database migrations and schema, deploy and cron workflows, environment settings, Stripe keys and gateway settings, and prices, fees or the take cap. Leave those PRs open and tell the user.
- After merging, confirm the head is in `origin/main` and the `migrate` job passed.

Parallel work gets its own worktree, local database (`tutor_finder_<item>`), dev-server port and fake-Stripe state. Port 3000 belongs to the user.
