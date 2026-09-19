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
```

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
at Calc I and mediocre at Organic. Quality scores are per-course.

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
