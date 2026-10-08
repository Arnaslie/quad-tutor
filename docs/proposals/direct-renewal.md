# Proposal: direct mid-term renewal and the one-session refill

Status: **proposal, not started; every question answered.** Written 2026-10-08 against
`origin/main` at `35a804d`. Updated the same day with the user's answers. The tutor
sees the requested package before accepting. The first-session guarantee is removed,
and a student can end a package early instead. Those two ship together as their own
build item, below. Nothing in `docs/decisions.md` changes until this is accepted; the
exact replacement text is in its own section.

## The item

> Direct mid-term renewal is the next item after public ratings. A pair renews with
> the same tutor from their thread or the session page, without going back through the
> deck or making a new request. (`docs/decisions.md:524-529`)

Decided by the user on 2026-10-08, and taken as input here:

1. Direct renewal ships together with a one-session refill.
2. One "Book again" entry, from the thread and from the session page, with three options:
   through the final (default, `decisions.md:517-522`), exam-anchored second, and one
   more session.
3. The refill is available whenever the pair has nothing left to book and the term has
   not ended, no longer only near the end of term. This revises
   `decisions.md:42-56`, on that section's own reasoning. Cold one-offs stay rejected:
   the single session is only for an existing pair.
4. The refill books straight into one of the tutor's published open slots, as top-ups
   do today. The two packages go as a request to that one tutor, skipping the deck, and
   need the tutor's accept.
5. **The tutor sees the requested package before accepting**, and checkout is locked to
   it. Accepting commits the tutor to that many sessions and slots, so a tutor who can
   fit three sessions must be able to decline a four-pack or an eight-session through
   the final.
6. **The first-session refund guarantee is removed entirely.** In the user's words: "if
   you buy a session, you're committing, no free lunch."
7. **A student can end a package early.** Undelivered sessions are refunded and
   delivered ones stay paid. This replaces the guarantee, so it ships with the removal
   as one separate build item, on its own branch and PR, specified after the renewal
   slice.

## Recommendation

**Build it on the paths that already exist: one additive column, no new sweep, no new
table.**

- **A package renewal is an ordinary `match_request`** to one `tutor_course`, created by
  the same code as a deck ask. It gets the 12h expiry, the request emails, the tutor's
  accept and decline, the silent-expiry penalty, the parallel-ask limit and the
  charge-after-accept checkout for free. The only difference from a deck ask is where
  the student pressed the button.
- **Every new request carries the package**, in a nullable
  `match_request.requested_kind`. The tutor sees it on the request card and in the
  email, and checkout buys exactly that kind.
- **Deck asks carry it too.** The user's reason, that accepting commits the tutor to a
  number of sessions, applies to a first purchase at least as much as to a renewal: it
  is when the tutor knows the student least. One rule on every request gives one accept
  screen, one email and one checkout rule. Carrying it on renewals only would leave
  the tutor accepting an unknown commitment on exactly the asks where they know least,
  and checkout would need two rules (locked for renewals, free for deck asks). The
  cost is one choice on the deck's ask form, preselected to exam-anchored, which is
  still the settled first-purchase default (`decisions.md:28-32,522`). The column is
  nullable only because requests made before the migration have no kind. Their
  checkout stays a free pick, as today.
- **The refill is today's top-up with the calendar condition removed** and its gate
  moved from one engagement to the pair. It carries no request, so it carries no kind,
  and it still books directly with no accept.
- **One server predicate decides "can this pair book again"**, and every surface (thread,
  session page, sessions list, both purchase paths) asks it. That is the DRY part, and
  it is also where two latent bugs get fixed (below).

Two existing bugs block the item and are fixed in this slice:

- **A second accept in the same course always fails today.** `acceptRequest` refuses if
  the student has *any* `accepted` request for the offering
  (`src/server/modules/matching/requests.ts:162-176`). A request stays `accepted` after
  it is bought, so once a pair has bought one package, no later request in that course
  can ever be accepted, including the "Book another package" deck path the closed thread
  already offers (`src/server/modules/messaging/threads.ts:283-299`). The check should
  only count accepted requests that have **not** been bought, which is the same
  "accepted, not yet bought" test `threadOpen` already uses (`threads.ts:52-57`).
- **The top-up purchase never checks the slot.** `bookSession` checks the requested time
  against `availableSlots` and against a clash with the tutor's other bookings
  (`src/server/modules/engagements/scheduling.ts:117-125,138-152`). `purchaseTopUp` and
  `purchasePackage` insert whatever time they are given
  (`src/server/modules/engagements/purchase.ts:206-215,331-340`). "Books into one of the
  tutor's published open slots" is the whole justification for the refill having no
  accept step, so it has to be true in code.

## What exists today

- **Requests.** `requestTutors` (`requests.ts:44-120`) locks the student's pending asks,
  enforces `standing.parallelAskLimit` (`:66-70`), filters to active, same-campus,
  unblocked, not-self claims (`:75-90`), inserts `match_request` rows with
  `institution_id`, and opens the pair's thread in the same transaction (`:109-116`).
  Expiry is 12h (`src/server/modules/matching/candidates.ts:18`), enforced by
  `expireStaleRequests` (`requests.ts:28-33`) from the cron (`src/app/api/cron/route.ts:35`)
  and from every read. Silent expiries are counted per `tutor_course` for the ranker
  (`candidates.ts:129-135`). Request emails are keyed on the request row
  (`src/server/modules/notifications/dispatch.ts:252-259,307`), so any new request row
  is emailed the same way. The tutor email is `requestWaiting`
  (`src/server/modules/notifications/messages.ts:14-38`); the tutor's card is
  `RequestCard` (`src/app/(tutor)/tutor/page.tsx:134`), fed by `inboxForTutor`
  (`requests.ts:306-345`).
- **A request carries no package today.** `match_request` (`src/server/db/schema.ts:372-403`)
  has no kind. The tutor accepts the pair, and the student picks the package afterwards
  at checkout.
- **Accept.** `acceptRequest` (`requests.ts:122-198`) is first-accept-wins per
  (student, offering) and withdraws the student's other pending asks in that offering
  (`:185-194`). The winner check at `:162-176` is the bug above.
- **Checkout.** `purchasePackage` (`purchase.ts:133-228`) takes an accepted request, is
  idempotent on `engagement.match_request_id` (unique, `schema.ts:437`), and writes the
  engagement, the first `session_booking` and a `package_purchase` ledger row. It takes
  `kind` from the form (`src/app/(student)/actions.ts:124-130,158-165`). The checkout
  page is `PurchaseStep` (`src/app/(student)/requests/page.tsx:175-223`). The panel
  defaults to `exam_anchored` (`src/app/(student)/requests/purchase-panel.tsx:40`) and
  lists options in `packageOptions()` order, exam-anchored first
  (`src/server/modules/billing/pricing.ts:27-48`).
- **Top-up.** `topUpWindowOpen` (`pricing.ts:69-81`) is open when the engagement has no
  sessions left to book and fewer weeks remain than an exam-anchored package has
  sessions. `topUpSource` (`purchase.ts:230-285`) applies it **per engagement**
  (`:234-238`), with no block check and no check that the tutor's claim is still active.
  `purchaseTopUp` (`:299-353`) writes a `top_up` engagement with no `match_request_id`.
  `topUpCandidates` (`src/server/modules/engagements/reads.ts:226-284`) lists one row per
  finished engagement, not per pair.
- **Why per-engagement breaks once the window widens.** A pair with an old, used-up
  four-pack and a new through-final with six sessions left would be offered a refill
  against the old one, and a pair with two finished engagements gets two cards. Near
  term end this is rare; mid-term it is the normal case.
- **Entry points.** The thread shows "Book another package" only when it is closed
  (`threads.ts:232`, `src/app/messages/[threadId]/page.tsx:65-78`), linking to the top-up
  if one is open and otherwise to the deck (`threads.ts:266-300`). The session page has
  a message link and the rating card (`src/app/(student)/sessions/[id]/page.tsx:92,109`)
  and no booking entry. The sessions list shows "One more before finals?" cards
  (`src/app/(student)/sessions/page.tsx:108-117,130-156`) and the top-up step at
  `?topup=` (`:31-48,158-222`).
- **Thread writability** is computed (`threads.ts:42-66`): a live pending request, an
  accepted-not-bought request inside its term, or an active engagement. A new direct
  request or a refill engagement reopens the thread with no change to this code.
- **Ranker renewal term.** `refreshScores` (`src/server/modules/scoring/stats.ts:40-63`)
  takes each pair's first engagement as the trial if it ran (completed, or guarantee
  refunded, `:45`), and counts a success when the pair has **more than one engagement of
  any kind** (`:46`). A refill (`top_up`) and a renewal package are both a second
  engagement, so both count, once per pair. No change needed.
- **Money.** A purchase writes only `package_purchase` (deferred). Revenue, tutor pay and
  the capped fee are written per delivered session in `recognise()`
  (`src/server/modules/engagements/confirmation.ts:26-80`), reading the term from the
  engagement's offering. Unused sessions refund at term end
  (`src/server/modules/engagements/termEnd.ts:31-56,77-152`).
- **The term-end refund path.** `refundUnusedSessions` (`termEnd.ts:77-152`) locks the
  engagement and cancels every `scheduled` booking (`:103-111`). It does not set
  `cancelled_by_user_id`, so no cancel email goes out. It refunds
  `price − delivered × per-session` as a single `refund` row (`:58-75,127-138`) and
  closes the engagement as `completed` if any session was delivered, `refunded` if none
  (`:140-147`). It takes no actor and checks no ownership, because only the sweep calls
  it. Two things it does not guard against, harmless at term end but not mid-term:
  - a past session that is still `scheduled` because its confirmation window is open
    gets cancelled and refunded;
  - a `disputed` session counts as undelivered, so it is refunded and can still be
    recognised later if the dispute resolves as attended.
- **Cancels.** `cancelSession` (`scheduling.ts:172-226`) writes a `late_cancelled` fact
  when the student cancels within `LATE_CANCEL_HOURS` (12h, `attendance.ts:5`). The
  cancel email goes to the other party for any cancelled row with a
  `cancelled_by_user_id` (`dispatch.ts:357-383`).
- **The guarantee is a promise with no button.** `claimGuarantee` (`purchase.ts:359-437`)
  and `guaranteeAbsorbed` (`src/server/modules/billing/ledger.ts:79-92`) have no caller
  anywhere in `src/app`. The only student-facing trace is the checkout line "Your first
  session is covered by a refund guarantee, self-serve, no questions"
  (`purchase-panel.tsx:172-173`). Today that line promises something the student cannot
  claim. `stats.ts:45` and `stats.test.ts:87-98,193-221` read `guarantee_used`.

## How the pieces fit

**One predicate, `bookAgain`.** In `engagements/reads.ts`, for the actor and a
`tutor_course`:

- the student has at least one engagement with that `tutor_course`, in an offering
  whose term has not ended (`term.ends_on >= current_date`), scoped by
  `engagement.institution_id = actor.institutionId`. That clause is what keeps cold
  one-offs out: no prior engagement, no row;
- the sessions left to book, **summed over the pair's active engagements in that
  offering**, is 0;
- the claim is `active` and the pair is not blocked (`blockedBetween`, the same filter
  `requestTutors` uses);
- it also returns the pair's live request, if any: pending (show "waiting on the
  tutor"), or accepted and not bought (link to checkout). That stops a second ask
  while one is out.

It returns the offering, the latest engagement, the tutor's name and spot, and the
term end, or `null`. A list form backs the sessions page, one row per pair. The
calendar test stays a pure function in `pricing.ts` (it imports nothing):

```ts
export function bookAgainOpen(p: { sessionsRemaining: number; termEndsOn: Date; now: Date }) {
  return p.sessionsRemaining === 0 && p.termEndsOn.getTime() > p.now.getTime();
}
```

This replaces `topUpWindowOpen`. `EXAM_ANCHORED_SESSIONS` no longer drives the window.

**The requested kind.** `requestTutors` gains a `kind: "exam_anchored" |
"through_final"` argument and writes it to every row it inserts, so up to three parallel
deck asks all ask for the same package. Zod at both boundaries allows only those two;
`top_up` is never a request. The deck's ask form gains the choice, preselected to
exam-anchored. `inboxForTutor` and `requestWaiting` add one line, for example
"4 sessions, to the exam on Oct 14" or "8 sessions, through the final". It shows the
session count, because that is what the tutor is committing to. On the student side,
`StudentRequest` carries it, so the "said yes" card names the package. At checkout,
`purchasePackage` uses `request.requestedKind ?? params.kind`. The form's `kind` is read
only for a request made before the migration, which has none. `PurchasePanel` shows
the locked package with no picker when the request has one. The anchor exam is still
picked at checkout, as today.

**A package renewal** is `requestRenewal({ actor, tutorCourseId, kind })` in
`matching/requests.ts`: call `bookAgain`, then `requestTutors({ actor,
courseOfferingId: gate.offeringId, tutorCourseIds: [tutorCourseId], kind })`. Nothing
else is new. The Book again step preselects through the final, the settled renewal
default. The ask counts against the student's parallel-ask limit, because it is one;
the reduced limit is a settled reliability mechanic and a renewal is not an exemption
from it. If the tutor declines or the ask expires, `bookAgain` is open again. The
student can ask for the smaller package, take the refill, or go back to the deck.

**The refill** is `purchaseTopUp({ actor, tutorCourseId, slotStartsAt })`. Inside the
transaction it locks the `tutor_profile` row first (the order `decisions.md:96-101`
already allows for purchase), re-runs `bookAgain`, then runs the slot check shared with
`bookSession`. The lock plus the clash check is also the double-submit guard: the
second click finds its slot taken.

**Ledger and cap: unchanged.** Both paths write one `package_purchase` row at purchase
and nothing else. Every delivered session is recognised by `recognise()` against the
tutor's meter for the engagement's term, so a renewal or refill fee is a fee like any
other and the meter stays a sum over the ledger. A refill is $35 a session; a
through-final renewal is $31.50, and its undelivered sessions refund at term end.

**Reliability: untouched.** Nothing here writes or reads `reliability_event` except
the existing `standingFor` call inside `requestTutors`.

## MVP slice

One branch and PR, e.g. `feat/direct-renewal`.

| Part | Owner | Build |
|---|---|---|
| Schema | Database engineer | **One additive migration** (`drizzle/0022_…`): `match_request.requested_kind package_kind null`, with `check (requested_kind is null or requested_kind <> 'top_up')`. No backfill and no NOT NULL, so there is no contract step. Review the plans for `bookAgain` (it should use `engagement_student_idx` and `engagement_tutor_course_idx`) and for the accept check's `not exists` (on `engagement_match_request_idx`). |
| Rule | Backend engineer | `pricing.ts`: `bookAgainOpen` replaces `topUpWindowOpen`. Unit tests in `pricing.test.ts`: remaining > 0, term ended, and an open window mid-term. |
| Pair read | Backend engineer | `engagements/reads.ts`: `bookAgain(actor, tutorCourseId)` and its list form, replacing `topUpCandidates`. Every query carries `institution_id`. It returns no score field. |
| Accept fix | Backend engineer | `requests.ts:162-176`: count only accepted requests with no engagement. Tests: a pair that bought, then renews, can be accepted; a second tutor still cannot accept while another accept is unbought. |
| Requested kind | Backend engineer | `requestTutors` takes and writes `kind`, and `requestRenewal` is gated by `bookAgain`. Zod in `matching/input.ts`. `inboxForTutor`, `requestsForStudent` and `requestWaiting` carry the kind. `purchasePackage` locks to it. Test: a request for 4 cannot be bought as 8. |
| Refill and checkout | Backend engineer | `purchaseTopUp` is keyed on `tutorCourseId` and gated by `bookAgain`. Extract the slot and clash check from `bookSession` (`scheduling.ts:117-152`) into one helper, called from `bookSession`, `purchaseTopUp` and `purchasePackage`. |
| Threads | Backend engineer | `threadView` returns the Book again link from `bookAgain` whether or not the thread is open. A closed thread with no bookable pair keeps the course-list link. Update `messaging.test.ts:321-342` for the new href. |
| Concurrency | Distributed-systems engineer | The tutor lock in `purchaseTopUp` comes before the slot check, in the documented order. Confirm that `expireStaleRequests`, the request emails and the thread alert pacing need no change for direct asks: they are keyed on rows that already exist. The request email's idempotency key is per row and the kind never changes after insert, so a reused key cannot carry a different body. No new cron step. Test two concurrent refills for one slot: exactly one succeeds. |
| Stats | Backend engineer | No code change in `stats.ts`. Add `stats.test.ts` cases: a refill and a direct-renewal package each make the pair a success once; an accepted renewal that was never bought does not. |
| Pages | Web engineer | **Book again:** one step at `/sessions?again=<tutorCourseId>`, replacing `?topup=`. Through the final is preselected, then exam-anchored, then one more session. A package submits `requestRenewal` with the chosen kind ("Ask {tutor} for 8 sessions through the final. Nothing is charged until they say yes."). One more session shows the slot picker and checks out. **Links:** from the thread (replacing the closed-only button), from the session page next to the message link, and from the sessions list, whose card loses "before finals". **Deck ask form:** one package choice, exam-anchored preselected. **Tutor request card:** shows the requested package. **`PurchasePanel`:** shows the locked package; the picker remains only for kind-less legacy requests. |
| Gate | Code reviewer | See below. |

**Gate (Code reviewer).**

- No path writes a `top_up` engagement for a student with no earlier engagement in that
  `tutor_course`. Test it.
- No refill or package purchase accepts a time outside `availableSlots` or one that
  clashes.
- Checkout cannot buy a kind other than the request's `requested_kind`.
- A renewal ask is a `match_request`: it has the normal expiry, counts against the
  parallel-ask limit, and is charged only after the accept and a slot pick.
- A blocked pair, or an inactive claim, gets no Book again link and no refill.
- Every new or changed query carries `institution_id`.
- Nothing new crosses into `TutorCard`. The student-facing additions are the requested
  kind and the Book again link, both facts about the student's own pair.
- Nothing writes `reliability_event`, and nothing writes a ledger row at purchase other
  than `package_purchase`.

Out of the slice:

- Clamping offered slots to the term end. A refill bought in the last days can still
  pick a slot after `ends_on`, and the sweep then refunds it. Top-ups work the same way
  today.
- A "returning student" label in the tutor inbox.
- The V1 bandit.

## Separate build item: remove the guarantee, let a student end a package early

Its own branch and PR (e.g. `feat/end-package-early`). Early ending replaces the
guarantee, so the two ship together; neither is bundled with renewal, and the renewal
PR and this one can merge in either order.

**Ending early is the term-end refund, run on demand.** Split the body of
`refundUnusedSessions` into one function that takes a transaction and an optional
ending student, `closeWithRefund(tx, engagementId, endedBy?)`. The sweep and the new
`endPackage({ actor, engagementId })` both call it. There is one refund calculation,
one ledger write and one status rule, and no second refund path.

- **Who and when.** Only the engagement's student can end it, scoped by
  `engagement.institution_id = actor.institutionId`, and only while it is `active`.
  The tutor cannot end a student's package; that would be a refund the payer did not
  ask for.
- **Refused, with a reason, while any session is at a point where cancelling it would
  be wrong:**
  - **inside the late-cancel window** ("Your session on Tue is less than 12 hours away.
    You can end the package after it.");
  - **past its start but unconfirmed** ("Answer whether Monday's session happened
    first.");
  - **disputed.**

  The first rule exists for the reliability invariant. Ending a package is a money
  action and writes **no reliability fact**. If it could cancel a session inside the
  window, it would either have to write `late_cancelled`, a fact minted by a refund
  button, or become a way around the fact `cancelSession` writes for the same act.
  Refusing keeps the only source of `late_cancelled` where it is: a student who really
  means to cancel late still can, through the normal cancel, which records the fact,
  and can end the package after that. The other two rules stop a refund of a session
  that may have happened, which is the free lunch the user just removed. They also close
  both holes listed under What exists today for this path. The sweep keeps today's
  behaviour; fixing it at term end is not this item.
- **Future bookings.** Every `scheduled` session left (all of them more than 12h away,
  by the rule above) is cancelled with `cancelled_at = now` and `cancelled_by_user_id`
  = the student. That is exactly what a student's on-time cancel writes, so the
  existing dispatch sends the tutor the existing "session cancelled" email for each one
  (`dispatch.ts:357-383`), with its idempotency key. No new email. A package with no
  future bookings sends nothing: nothing on the tutor's calendar changed. The tutor sees
  the package closed on their board.
- **Ledger.** One `refund` row for `price − delivered × per-session`. That is the same
  formula as the sweep, a reversal of deferred revenue only. No `platform_fee`, no
  `tutor_payout`, nothing recognised, so the take-cap meter is untouched, as
  `decisions.md:87-88` already says of term-end refunds. Delivered sessions keep their
  `session_earned` rows and the tutor keeps their pay. Floor rounding is the sweep's:
  through the final at $31.50 a session refunds to the cent.
- **End status and the ranker.** The same rule as the sweep: `completed` if any session
  was delivered, `refunded` if none. Applying the 2026-10-07 rule as written: a first
  package ended with nothing delivered never ran, so it is not a trial. One ended after
  delivered sessions ran, so it is a trial, and without a later purchase it is a failed
  one. That failed trial is the signal the guarantee refund used to give, now earned
  through a session that was actually delivered. `stats.ts` needs no change. With
  `guarantee_used` false, a `refunded` package is not "ran", and a `completed` one is.
- **Thread.** Nothing to build. `threadOpen` needs an active engagement or a live
  request (`threads.ts:42-66`), so ending the pair's last package closes the thread on
  the next read. History stays visible, and Book again appears (once that ships)
  because the pair has nothing left to book.

| Part | Owner | Build |
|---|---|---|
| Schema | Database engineer | **No migration.** Keep `engagement.guarantee_used` and the `guarantee_absorbed` ledger type for history; nothing destructive. Review the plan for `endPackage`'s session checks (on `session_engagement_idx`). |
| Remove guarantee | Backend engineer | Delete `claimGuarantee` (`purchase.ts:359-437`) and `guaranteeAbsorbed` (`ledger.ts:79-92`). Neither has a caller, so there is no action or route to remove. After this PR nothing sets `guarantee_used`. |
| End early | Backend engineer | `closeWithRefund` extracted from `refundUnusedSessions`. `endPackage` in `engagements/`, with Zod at the boundary, the ownership check and the three refusals. Tests: refund equals the sweep's for the same state; no `reliability_event` row; refusal at 11h, success at 13h; refusal while unconfirmed or disputed; a zero-delivered end is `refunded`, a one-delivered end is `completed`; a second call is a no-op. |
| Stats | Backend engineer | Leave `stats.ts:45` as it is, so historical guarantee refunds stay failed trials and no past trial moves. Keep the `guarantee_refunded` fixtures in `stats.test.ts`, rename that test so it reads as history, and add the two early-end cases. |
| Concurrency | Distributed-systems engineer | `endPackage` takes the engagement lock before reading sessions, as the sweep does. The sweep is already safe against it: it re-reads `status` under the same lock (`termEnd.ts:101`). **`bookSession` is not.** It reads `status` before its transaction (`scheduling.ts:79`), so a booking racing an end could land on a closed, refunded package. Fix: lock the engagement row (`for share`) and re-check `active` inside the booking transaction. Test `endPackage` against the term-end sweep on the same package: exactly one `refund` row. |
| Pages | Web engineer | "End this package" on the student's package card (`sessions/page.tsx`). It confirms with the refund amount and the sessions that will be cancelled, or shows the refusal reason. The checkout line at `purchase-panel.tsx:172-173` becomes "Sessions you do not use are refunded at the end of term, or when you end the package." Remove the guarantee wording everywhere. |
| Gate | Code reviewer | `grep -ri guarantee src` returns only the schema column, the ledger enum and `stats.ts`/`stats.test.ts`. Nothing writes `guarantee_used = true`. `refreshScores` output for the seeded campus is identical before and after. Ending writes no `reliability_event`, no fee and no payout. Every new query carries `institution_id`. |

## Invariant and decision conflicts

- **Revises `decisions.md:42-56`** (single session only at end of term), by the user's
  decision. Recorded below as a revision and in Reversed.
- **`decisions.md:520-521`** says "The end-of-term top-up rule is unchanged". That
  sentence goes.
- **`decisions.md:524-529`** says a direct renewal skips "making a new request" and in
  the next sentence that it "is a request to this one tutor". This proposal reads it as
  the second: a new `match_request` row, not a new trip through the deck. Recorded
  below so the two sentences stop disagreeing.
- **Double opt-in (`decisions.md:156-161`) holds**, and is strengthened: the tutor now
  accepts a named package, not only the pair. The refill has no accept step, as top-ups
  never did, and the slot fix makes "the tutor published that slot" true in code.
- **Intake under 45 seconds (`decisions.md:218-220`).** The deck ask gains one choice,
  but it comes after intake and has a default, so the intake itself is not slower.
- **Renewal signal integrity.** The record says renewal "costs two paid packages to
  fake" (`decisions.md:494`). A top-up already counted as a success, so it already cost
  one package that ran plus $35. Widening the refill makes that cheaper path available
  all term, not only in the last weeks. It is still a paid, delivered first package plus
  a paid session. Noted, not a blocker.
- **Guarantee removal** reverses `decisions.md:34-37`. It also touches every rule that
  leans on that paragraph: the cap's reversal bullet (`:87-93`), the guarantee's cost
  bullet (`:112-114`), rateable sessions (`:324-326`), and the trial definition
  (`:482-484,492`). All are rewritten below. No invariant is affected: money stays in
  minor units, and no history is rewritten.
- **Ending early against the invariants.** Reliability: it writes no fact, and it
  refuses rather than cancel inside the late-cancel window (see the build item).
  Deferred revenue: it reverses only unrecognised money. Cap: untouched. Breakage
  (`decisions.md:39-40`): unused money goes back sooner, never later. Anti-leakage
  (`decisions.md:630-634`): a student can now leave a package mid-term, which weakens
  the prepaid package as a lock. The user accepted that by choosing this option.
- **Ratings.** A refill session is rateable like any completed session. No change.
- **Tenant key, cap, ledger, reliability, hidden score:** no conflict (see How the
  pieces fit).

## Changes to `docs/decisions.md` if accepted

1. **Header, line 8.** Replace `Last updated: 2026-10-05.` with
   `Last updated: 2026-10-08.`

2. **Product, lines 34-37.** Replace the guarantee paragraph with:

   > **The first session is paid, with no refund guarantee and no free intro.** Free
   > intros burn scarce supply on people who were never going to buy. The self-serve
   > first-session guarantee was removed on 2026-10-08 (see Reversed): buying a session
   > is a commitment, and a delivered session stays paid.
   >
   > **A student can end a package early** (user, 2026-10-08). This replaces the
   > guarantee as the way out of a bad fit. Ending runs the term-end refund on demand:
   > - The sessions not yet delivered are refunded and the delivered ones stay paid.
   > - Future bookings are cancelled and the tutor is emailed for each, as for any
   >   on-time cancel.
   > - The package closes as `completed` if anything was delivered, otherwise as
   >   `refunded`.
   >
   > It moves only deferred money: no fee, no payout, and the cap meter is not touched.
   > Ending writes no reliability fact. It is refused while a session is inside the
   > late-cancel window, past its start and unconfirmed, or disputed. A late cancel stays
   > something only the cancel action records, and a session that may have happened is
   > never refunded. Only the student can end their package.

3. **Product, lines 42-56.** Replace both paragraphs with:

   > **A single session exists, but only for an existing pair.** One session, full
   > price, offered to a student whose packages with that tutor in a course have nothing
   > left to book, at any point before the term ends. Revised 2026-10-08: it used to be
   > an end-of-term top-up only (see Reversed). It is not a cheaper door into the
   > product: a cold one-off has no dosage, a $3.50 take on a $35 session does not pay
   > for course-level matching, and a pair who met once has no reason to come back
   > through the platform. Cold one-offs stay rejected. A renewal shares none of that —
   > the matching cost is sunk, the tutor is known, the dosage already happened, and the
   > pair could already have left and did not. None of those reasons depend on the
   > calendar, so the refill does not either.
   >
   > What it fixes is the gap after a package, which the package shape gets wrong. A
   > student who used four sessions and wants one more before the next exam otherwise
   > chooses between another four-pack that partly auto-refunds and texting the tutor
   > directly. The second is free and easier, so the package rule was producing leakage
   > at the exact moment the relationship is worth most. Refills chain: a
   > booked-but-unheld session leaves nothing to book, so a second can be bought before
   > the first happens, which is what finals week actually looks like.
   >
   > The refill books straight into one of the tutor's published open slots, with no
   > accept step: the tutor already offered that hour, and one session commits them to
   > nothing beyond it. A package needs the tutor's accept (see Renewals).

4. **Product, take cap, "Reversals follow the tutor's pay", lines 87-93.** Delete the
   sentences from `A guarantee` to `the same clawback by another route.` The bullet then
   reads:

   > - **Reversals follow the tutor's pay.** A term-end refund, and a package the student
   >   ends early, return only undelivered sessions, which never charged a fee, so
   >   neither touches the meter. A disputed
   >   session charges nothing while it holds; resolved as attended, it is charged at
   >   resolution against the meter as it stands then; resolved as not attended, never.
   >   Nothing today reverses a recognised session. If something ever does, and takes the
   >   tutor's pay back with it, it reverses the fee row too and the room returns.

5. **Product, take cap, lines 112-114.** Delete the bullet "The guarantee's cost is
   accepted as is."

6. **Matching and interaction, after "Double opt-in" (line 158).** Insert:

   > **A request names its package.** The student picks exam-anchored or through the
   > final when asking, and the tutor sees the number of sessions before accepting,
   > because accepting commits them to that many sessions and slots. A tutor who can fit
   > three sessions can decline an eight-session ask at no cost, like any pass. Checkout
   > buys exactly the requested package. Decided 2026-10-08. Requests made before then
   > carry no package and keep the free pick at checkout.

7. **Messaging, lines 232-235.** Replace from "When the last package ends" to the end
   of the paragraph with:

   > When the last package ends the thread closes, but it still opens and shows its
   > history. While the term runs, the student sees "Book again" (see Renewals) once the
   > pair has nothing left to book, whether the thread is open or closed. After the term
   > ends, a closed thread points to the course list. A renewal request or a refill
   > reopens the thread. A tutor whose request auto-withdrew keeps a read-only thread.

8. **Ratings, lines 324-326.** Delete the bullet "The session a guarantee refunded can be
   rated."

9. **Renewals, lines 482-484 and 492.** Replace the trial bullet with:

   > - **A trial** is a distinct student whose first engagement with that `tutor_course`
   >   ran: it ended `completed`. It counts per pair, so a student counts once. A first
   >   package refunded under the former guarantee (removed 2026-10-08) is still a trial,
   >   so past trials do not shift.
   > - **A first package the student ended early follows the term-end rule.** With
   >   sessions delivered it ends `completed`, so it is a trial. Without a later purchase
   >   it is a failed one. With nothing delivered it never ran, so it is not a trial.

   Replace `- **A guarantee refund counts as a failed trial.**` with:

   > - **A historical guarantee refund counts as a failed trial**, unless the pair bought
   >   again.

10. **Renewals, lines 520-521.** In "A mid-term renewal offers 'through the final'
    first", replace `The end-of-term top-up rule is unchanged.` with
    `One more session is the third option (see Product).`

11. **Renewals, lines 524-529.** Replace the paragraph with:

    > **Direct mid-term renewal: one "Book again" entry.** Decided 2026-10-08. Build
    > brief: `docs/proposals/direct-renewal.md`. From the thread or the session page,
    > once the pair's packages in the course have nothing left to book and the term has
    > not ended, the student sees three options in this order: through the final,
    > exam-anchored, one more session. The matching cost is sunk, which is the same
    > reasoning as the refill.
    >
    > - **A package is a request to this one tutor that skips the deck.** It is an
    >   ordinary `match_request` that names its package (see Matching). It has the same
    >   12h expiry and silent-expiry penalty and the same accept and decline. It is one
    >   of the student's parallel asks. It is charged only after the accept and a slot
    >   pick. Double opt-in holds on every package, because a package is a commitment
    >   the tutor has to agree to.
    > - **One more session books directly** into one of the tutor's published open
    >   slots, with no accept step (see Product).
    > - **Both count as a renewal success** for the ranker. Like the rest of the renewal
    >   term, neither ever reaches the student or the card.
    > - **A blocked pair gets neither**, and neither does a tutor whose claim on the
    >   course is no longer active.

12. **Reversed.** Append:

    > **Single session only as an end-of-term top-up — settled at design, revised
    > 2026-10-08.** The original rule offered one session only when fewer weeks remained
    > in the term than a package has sessions. The user revised it: the reasons a
    > renewal is worth having (matching cost sunk, tutor known, dosage happened, the pair
    > stayed) hold all term, and the gap after any package is a leakage moment, not just
    > the last one. Cold one-offs stay rejected. The current rule is under Product.
    >
    > **Self-serve first-session refund guarantee — settled at design, reversed
    > 2026-10-08.** The original rule: *"Paid first session under a self-serve refund
    > guarantee — not a free intro. On a refund the platform eats the tutor's pay rather
    > than clawing it back. Cap at one guarantee per student per term."* The user removed
    > it: "if you buy a session, you're committing, no free lunch." The column and ledger
    > type stay for history, and past guarantee refunds keep their meaning in the renewal
    > trial count. Ending a package early (see Product) is the way out of a bad fit
    > instead: it refunds only what was not delivered. The paid-first-session rule and
    > the rejection of free intros stand.

13. **Product, lines 39-40.** Replace with:

    > **Unused sessions refund at term end, or when the student ends the package.**
    > Breakage income is a trap on a campus where everyone talks.

## Questions for the user

None open. All three are answered and recorded above.

1. ~~**Should the tutor see which package the student wants before accepting?**~~
   **Answered 2026-10-08: yes.** Accepting commits the tutor to that many sessions and
   slots. Every new request names its package (`match_request.requested_kind`), deck
   asks included, and checkout is locked to it. The refill still books directly.
2. ~~**Does the first-session guarantee apply to renewals and refills?**~~
   **Answered 2026-10-08, more broadly: the guarantee is removed entirely.** "If you buy
   a session, you're committing, no free lunch."
3. ~~**With the guarantee gone, can a student end a package early?**~~ **Answered
   2026-10-08: yes.** Undelivered sessions are refunded and delivered ones stay paid.
   It is built with the guarantee removal (see the separate build item). The
   alternative, holding refunds until term end, was rejected.
