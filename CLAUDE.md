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
npm run dev          # dev server
npm run build        # production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run db:generate  # drizzle-kit: generate migration from schema
npm run db:migrate   # drizzle-kit: apply migrations
npm run db:studio    # drizzle-kit: browse data
npm run db:seed      # idempotent local campus: courses, professors, exams, tutors
npm run db:demo      # re-runnable: drives the real functions to a populated session board
```

The deadlines in the product (12h request expiry, 24h confirmation window, term-end
refunds) are only as accurate as the sweep that enforces them. `GET /api/cron` runs it,
guarded by `CRON_SECRET` and scheduled in `vercel.json`. The reads call the same sweeps
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
at Calc I and mediocre at Organic. Quality scores are per-course. They are hidden, and
hidden means **stripped server-side before anything crosses into a client component** —
a server component serialises its props into the RSC payload, so a score that is merely
never rendered is still one "view source" away from being a public rating. Map the
scored row down to the narrow shape the card displays. The test for any field added to
that shape: *could a student reconstruct an ordering from it?* A professor name, a term
and a grade are facts about the pair and are the student's to see; a decayed recency
weight or a sample count is the arithmetic performed on them, and is not.

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
