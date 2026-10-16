# Proposal: test users in production, in pre-built states

Status: **accepted 2026-10-14, build started.** Written 2026-10-14 against
`origin/main` at `701a296`. The accepted rule is in `docs/decisions.md` ("Test users
in production carry fixture money until launch").

## The problem

Two people test the product in production. Most of what they need to judge only
shows up after weeks of use: a tutor's rating going public, the
lower take after $100 in fees (`docs/proposals/lifetime-fee-milestone.md`), a ranking that
counts, a term of earnings, a package used up, finals week, term end. Waiting for real
time to pass makes those states untestable before launch.

## Decided by the user on 2026-10-14

1. Testing happens in production. There is no staging, and every production account
   is a test account today (`decisions.md`, "Data from before Stripe is test data").
2. Test users sign in with plus-aliases of the user's own inbox,
   `arnutislie12+<persona>@gmail.com`.
3. Test users make real transactions against Stripe **test mode**: buying a follow-up
   package, buying one session, ending a package for a refund. Production already runs
   on a test key. `realGateway()` refuses any `sk_live_` key
   (`billing/stripe.ts:320-325`).

## What exists today

- **Sign-in needs nothing new.** Sign-in is a magic link (`src/server/auth.ts:72-97`).
  An address outside the campus domain can sign in once it is in `institution_email`,
  which is how `db:seed` lets its plus-aliases in (`seed.ts:763-791`). Production
  sends mail through Resend, so a persona's link lands in the user's Gmail.
- **`db:demo` already builds states by driving the real functions**, then moving rows
  into the past with SQL (`moveIntoPast` in `src/server/db/scenarios/sessions.ts`). Nothing fakes the clock, and this
  proposal does not add one. Code reads both the app clock and the database clock, so
  only rewriting stored timestamps works for both.
- **The fake payment is refused in production** (`buy-and-pay.ts:5-26`), on purpose,
  and stays refused.
- **The transfer sweep never pays out a package with no Stripe reference**
  (`decisions.md`, "Data from before Stripe is test data").

## The design

### Two kinds of money

- **History is fixture money.** A persona's past (the 32 sessions a tutor already
  taught, the package a student already used up) is written with no Stripe charge
  behind it. It goes through the same module functions as real money, from purchase
  to recognition, so every split, fee tier and cap meter is computed by the real code.
  Only the step that would ask Stripe for a payment is swapped for one that records a
  fixture reference instead.
- **What the testers do is real test-mode money.** Every action a tester takes in the
  app goes through real Stripe Checkout with card `4242 4242 4242 4242`, the verified
  webhook and the real sweeps. No action a tester can take touches fixture money.

A refund on a fixture package would fail at Stripe, because no charge exists. So
every persona that is there to test a refund or a follow-up starts one step before
the purchase: an accepted request, or an open "Book again". The tester buys the
package for real, then ends it.

### Telling fixture money apart

- **Personas are found by user id.** Every persona's user id is `persona_<key>`, the
  same pattern `db:seed` uses for `seed_<key>`. A persona's engagements, sessions,
  ledger rows, ratings and reliability events all hang off those users, so no new
  column is needed.
- **Fixture references.** A fixture purchase records `fixture_pi_<uuid>` as its Stripe
  reference. A fixture payout records `fixture_tr_<uuid>`. Neither matches a real
  Stripe id.
- **Guards.** The fixture payment step refuses an engagement whose student or tutor is
  not a persona. The transfer sweep and the refund path refuse any `fixture_`
  reference, so fixture money can never reach Stripe. The refusal runs before any
  Stripe lookup too: the transfer sweep calls `chargeOf` on the payment intent before
  it sends anything (`billing/transfers.ts`).
- **The money check.** `db:check-money` accepts a `fixture_` reference only on an
  engagement between personas. Anywhere else, it is a violation.
- **The wipe.** Before launch, deleting everything under `persona_` users removes all
  fixture money in one step, along with the rest of the test data
  (`decisions.md`, "Data from before Stripe is test data").

### Running it

- **A "Reset test users" button on `/ops`**, shown to operators only, and only while
  the `TEST_PERSONAS` environment variable is `on`. Pressing it deletes every persona
  and rebuilds them all from the scenario pieces, so it is safe to press at any time.
  No agent and no laptop needs the production database password.
- **The same scenarios run locally** through `npm run db:personas`, against the fake
  Stripe.
- **The page lists each persona**: its email, its role, and the state it is in, in one
  line ("Tutor, 32 sessions, $1,014.00 earned, past $100 in fees").
- **Turning it off.** At launch, `TEST_PERSONAS` is removed and the wipe runs. The
  button and the fixture payment step then refuse to run.

## The personas

Each persona is one state. Amounts follow the pricing rule in `docs/decisions.md` (10%
until a tutor has paid $100 in fees, then 5% for good), and rates vary by course,
from $25 to $50 for realism. Every amount is computed by the real pricing code when the persona
is built, not hard-coded.

**Tutors**

| Persona | State |
|---|---|
| `tutor-new` | Approved for a course, 0 sessions, no rating, waiting for a first request |
| `tutor-1` | 1 session at $50; earned $45.00 |
| `tutor-9` | 9 sessions; one away from a public rating |
| `tutor-10` | 10 sessions at $35, 5 released ratings, rating public; earned $315.00 |
| `tutor-ranked` | 20+ rated sessions in one course, so the ranking's star and renewal terms count |
| `tutor-32` | 32 sessions at $35 in one term; the 29th crosses $100 in fees; earned $1,014.00, some paid out and some owed |
| `tutor-past-100` | 32 sessions at $50; the 20th lands on $100 in fees, and the 12 after it pay 5% |
| `tutor-held` | Earned, but pay held: KYC not finished |
| `tutor-disputed` | One session disputed, so that engagement's pay is paused |
| `tutor-finals` | Several students with exams this week, a full calendar |

**Students**

| Persona | State |
|---|---|
| `student-new` | Signed up, nothing requested |
| `student-accepted` | A tutor accepted a request; ready to buy a first package for real |
| `student-mid` | Partway through a first package, with a session coming up |
| `student-confirm` | A session ended and waits for their attendance confirmation |
| `student-done` | Package used up; "Book again" open, to buy a follow-up or one session for real |
| `student-refund` | Accepted request for a package to buy for real, then end for a refund |
| `student-strikes` | Two late cancellations, so fewer parallel requests |
| `student-finals` | Exam this week, sessions booked around it |
| `student-term-over` | Package in a term that has ended, with the term-end refund still pending |

Personas work in pairs where a state has two sides: `tutor-finals` and
`student-finals` share engagements, and so do `tutor-disputed` and its student.

## Answered by the user on 2026-10-14

1. **Both testers use the same inbox.** Every persona is a plus-alias of
   `arnutislie12@gmail.com`, and both testers read the links there. There is one set
   of personas.
2. **The money-check exception is signed off.** Fixture references are allowed,
   limited to payments between personas and removed by the wipe at launch.

## New text for `docs/decisions.md`

Added after "Data from before Stripe is test data, and it is cleared before launch",
as "Test users in production carry fixture money until launch". That paragraph is
the rule; this proposal does not repeat it.

## PRs

1. This proposal and the `decisions.md` edit.
2. The scenario pieces, pulled out of `db:demo`. Behavior-preserving, merged in #76.
3. The fixture payment step, its guards and the money-check exception. It touches
   money, so merge-gate flags it and you merge it.
4. The tutor personas, after the pricing PRs land.
5. The student personas.
6. The end-of-term and finals personas.
7. The "Reset test users" button on `/ops`, and `TEST_PERSONAS`. It adds an
   environment setting, so you merge it and set the variable.
8. `test/daily-workflows` rebuilt on the scenario pieces, with its fixture emails
   fixed.
