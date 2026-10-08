# Proposal: direct mid-term renewal and the one-session refill

Status: **proposal, not started.** Written 2026-10-08 against `origin/main` at
`35a804d`. The shape below follows the user's decisions of 2026-10-08. The two questions
at the end are what is still open. Nothing in `docs/decisions.md` changes until this is
accepted; the exact replacement text is in its own section.

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

## Recommendation

**Build it on the paths that already exist. No migration, no new sweep, no new table.**

- **A package renewal is an ordinary `match_request`** to one `tutor_course`, created by
  the same code as a deck ask. It gets the 12h expiry, the request emails, the tutor's
  accept and decline, the silent-expiry penalty, the parallel-ask limit and the
  charge-after-accept checkout for free. The only difference from a deck ask is where
  the student pressed the button.
- **The refill is today's top-up with the calendar condition removed** and its gate
  moved from one engagement to the pair.
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
  is emailed the same way.
- **Accept.** `acceptRequest` (`requests.ts:122-198`) is first-accept-wins per
  (student, offering) and withdraws the student's other pending asks in that offering
  (`:185-194`). The winner check at `:162-176` is the bug above.
- **Checkout.** `purchasePackage` (`purchase.ts:133-228`) takes an accepted request, is
  idempotent on `engagement.match_request_id` (unique, `src/server/db/schema.ts:437`),
  writes the engagement, the first `session_booking` and a `package_purchase` ledger row.
  The checkout page is `PurchaseStep` (`src/app/(student)/requests/page.tsx:175-223`);
  the panel defaults to `exam_anchored` (`src/app/(student)/requests/purchase-panel.tsx:40`)
  and lists options in `packageOptions()` order, exam-anchored first
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
  refunded), and counts a success when the pair has **more than one engagement of any
  kind** (`:46`). A refill (`top_up`) and a renewal package are both a second
  engagement, so both count, once per pair. No change needed.
- **Money.** A purchase writes only `package_purchase` (deferred). Revenue, tutor pay and
  the capped fee are written per delivered session in `recognise()`
  (`src/server/modules/engagements/confirmation.ts:26-80`), reading the term from the
  engagement's offering. Unused sessions refund at term end (`src/server/modules/engagements/termEnd.ts:33-56`).
- **Guarantee.** `claimGuarantee` (`purchase.ts:359-437`) accepts any engagement with
  exactly one delivered session (`:396-400`) if the student has never used one
  (`:402-414`). A refill is always that shape. See question 2.

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

**A package renewal** is `requestRenewal({ actor, tutorCourseId })` in
`matching/requests.ts`: call `bookAgain`, then `requestTutors({ actor,
courseOfferingId: gate.offeringId, tutorCourseIds: [tutorCourseId] })`. Nothing else
is new. The ask counts against the student's parallel-ask limit, because it is one; the
reduced limit is a settled reliability mechanic and a renewal is not an exemption from
it. When the tutor accepts, the student's existing request card links to the existing
checkout. `PurchaseStep` learns that the request is a renewal (the pair has an earlier
engagement) and passes `defaultKind="through_final"`, with through the final listed
first. If the tutor declines or the ask expires, `bookAgain` is open again, and the
refill and the deck are still there.

**The refill** is `purchaseTopUp({ actor, tutorCourseId, slotStartsAt })`: inside the
transaction, lock the `tutor_profile` row first (the order `decisions.md:96-101`
already allows for purchase), re-run `bookAgain`, then run the slot check shared with
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

| Part | Owner | Build |
|---|---|---|
| Schema | Database engineer | **No migration.** `package_kind` already has `top_up`, `engagement.institution_id` is NOT NULL since #38, and a renewal is a `match_request` row. Review the plans for `bookAgain` (it should use `engagement_student_idx` and `engagement_tutor_course_idx`) and for the accept check's `not exists` (on `engagement_match_request_idx`). |
| Rule | Backend engineer | `pricing.ts`: `bookAgainOpen` replaces `topUpWindowOpen`; unit tests in `pricing.test.ts` for remaining > 0, term ended, and a mid-term open window. |
| Pair read | Backend engineer | `engagements/reads.ts`: `bookAgain(actor, tutorCourseId)` and its list form, replacing `topUpCandidates`. Every query carries `institution_id`. Returns no score field. |
| Accept fix | Backend engineer | `requests.ts:162-176`: count only accepted requests with no engagement. Test: a pair that bought, then renews, can be accepted; a second tutor still cannot accept while another accept is unbought. |
| Direct request | Backend engineer | `requestRenewal` in `requests.ts`, gated by `bookAgain`, delegating to `requestTutors`. Zod input in `matching/input.ts`. |
| Refill and checkout | Backend engineer | `purchaseTopUp` keyed on `tutorCourseId`, gated by `bookAgain`. Extract the slot and clash check from `bookSession` (`scheduling.ts:117-152`) into one helper and call it from `bookSession`, `purchaseTopUp` and `purchasePackage`. `StudentRequest` gains `renewal: boolean`. |
| Threads | Backend engineer | `threadView` returns the Book again link from `bookAgain` whether or not the thread is open; a closed thread with no bookable pair keeps the course-list link. Update `messaging.test.ts:321-342` for the new href. |
| Concurrency | Distributed-systems engineer | Tutor lock in `purchaseTopUp` before the slot check, in the documented order. Confirm `expireStaleRequests`, the request emails and the thread alert pacing need no change for direct asks (they are keyed on rows that already exist). No new cron step. Test two concurrent refills for one slot: one succeeds. |
| Stats | Backend engineer | No code change in `stats.ts`. Add `stats.test.ts` cases: a refill and a direct-renewal package each make the pair a success once; an accepted renewal that was never bought does not. |
| Pages | Web engineer | One "Book again" step at `/sessions?again=<tutorCourseId>`, replacing `?topup=`: through the final (preselected), exam-anchored, one more session. The two packages submit `requestRenewal` ("Ask {tutor} to keep going. Nothing is charged until they say yes."); one more session shows the slot picker and checks out. Link to it from the thread (replacing the closed-only button), from the session page next to the message link, and from the sessions list, whose card loses "before finals". `PurchasePanel` takes `defaultKind`. |
| Gate | Code reviewer | See below. |

**Gate (Code reviewer).**

- No path writes a `top_up` engagement for a student with no earlier engagement in that
  `tutor_course`. Test it.
- No refill or package purchase accepts a time outside `availableSlots` or one that
  clashes.
- A renewal ask is a `match_request` with the normal expiry, counted against the
  parallel-ask limit, and it is charged only after accept and slot pick.
- A blocked pair, or an inactive claim, gets no Book again link and no refill.
- Every new or changed query carries `institution_id`.
- Nothing new crosses into `TutorCard` or any student shape except `renewal: boolean`
  and the Book again link, both facts about the student's own pair.
- Nothing writes `reliability_event` or a ledger row other than `package_purchase` at
  purchase.

Out of the slice: clamping offered slots to the term end (a refill bought in the last
days can still pick a slot after `ends_on` and be refunded by the sweep; that is true of
top-ups today), a "returning student" label in the tutor inbox, and the V1 bandit.

## Invariant and decision conflicts

- **Revises `decisions.md:42-56`** (single session only at end of term), by the user's
  decision. Recorded below as a revision and in Reversed.
- **`decisions.md:520-521`** says "The end-of-term top-up rule is unchanged". That
  sentence goes.
- **`decisions.md:524-529`** says a direct renewal skips "making a new request" and in
  the next sentence that it "is a request to this one tutor". This proposal reads it as
  the second: a new `match_request` row, not a new trip through the deck. Recorded
  below so the two sentences stop disagreeing.
- **Double opt-in (`decisions.md:156-161`) holds** on both packages. The refill has no
  accept step, as top-ups never did; the slot fix makes "the tutor published that slot"
  true in code.
- **Renewal signal integrity.** The record says renewal "costs two paid packages to
  fake" (`decisions.md:494`). A top-up already counted as a success, so it already cost
  one package that ran plus $35. Widening the refill makes that cheaper path available
  all term, not only in the last weeks. It is still a paid, delivered first package plus
  a paid session. Noted, not a blocker.
- **Ratings.** A refill session is rateable like any completed session. No change.
- **Tenant key, cap, ledger, reliability, hidden score:** no conflict (see How the
  pieces fit).
- **Guarantee rule and code disagree** (pre-existing): the record says one per student
  per term (`decisions.md:37`), and `claimGuarantee` allows one per student ever
  (`purchase.ts:402-414`). Not touched here; flagged for whoever owns it.

## Changes to `docs/decisions.md` if accepted

1. **Header, line 8.** Replace `Last updated: 2026-10-05.` with
   `Last updated: 2026-10-08.`

2. **Product, lines 42-56.** Replace both paragraphs with:

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
   > nothing beyond it. A package renewal needs the tutor's accept (see Renewals).

3. **Messaging, lines 232-235.** Replace from "When the last package ends" to the end
   of the paragraph with:

   > When the last package ends the thread closes: it still opens and shows its history.
   > While the term runs, the student sees "Book again" (see Renewals) in the thread
   > whether it is open or closed, once the pair has nothing left to book; after the
   > term, a closed thread points to the course list. A renewal request or a refill
   > reopens it. A tutor whose request auto-withdrew keeps a read-only thread.

4. **Renewals, line 520-521.** In "A mid-term renewal offers 'through the final'
   first", replace `The end-of-term top-up rule is unchanged.` with
   `One more session is the third option (see Product).`

5. **Renewals, lines 524-529.** Replace the paragraph with:

   > **Direct mid-term renewal: one "Book again" entry.** Decided 2026-10-08. Build
   > brief: `docs/proposals/direct-renewal.md`. From the thread or the session page,
   > once the pair's packages in the course have nothing left to book and the term has
   > not ended, the student sees three options in this order: through the final,
   > exam-anchored, one more session. The matching cost is sunk, which is the same
   > reasoning as the refill.
   >
   > - **A package is a request to this one tutor that skips the deck.** It is an
   >   ordinary `match_request`: the same 12h expiry and silent-expiry penalty, the
   >   same accept and decline, one of the student's parallel asks, and charged only
   >   after the accept and a slot pick. Double opt-in holds on every package, because
   >   a package is a commitment the tutor has to agree to.
   > - **One more session books directly** into one of the tutor's published open
   >   slots, with no accept step (see Product).
   > - **Both count as a renewal success** for the ranker, and like the rest of the
   >   renewal term, never reach the student or the card.
   > - **A blocked pair, or a tutor whose claim on the course is no longer active,
   >   gets neither.**

6. **Reversed.** Append:

   > **Single session only as an end-of-term top-up — settled at design, revised
   > 2026-10-08.** The original rule offered one session only when fewer weeks remained
   > in the term than a package has sessions. The user revised it: the reasons a
   > renewal is worth having (matching cost sunk, tutor known, dosage happened, the pair
   > stayed) hold all term, and the gap after any package is a leakage moment, not just
   > the last one. Cold one-offs stay rejected. The current rule is under Product.

7. If question 1 is answered "yes", add to the Renewals bullet on packages: *"The
   tutor sees which package the student wants before accepting, and checkout is fixed
   to it."*

## Questions for the user

1. **Should the tutor see which package the student wants before accepting?**
   *Recommendation: no.* The tutor accepts the pair, exactly as on a first purchase,
   and the student picks the size at checkout with through the final preselected. That
   needs no migration and keeps one accept flow. *Strongest alternative:* store the
   student's pick on the request (one nullable `match_request.requested_kind` column)
   so the tutor's inbox reads "wants sessions through the final" and checkout is fixed
   to it. It matches your reasoning that a package is a commitment the tutor agrees to
   more literally, at the cost of a migration and a request that means different things
   on the two paths.
2. **Does the first-session guarantee apply to renewals and refills?**
   *Recommendation: no, only to the pair's first engagement.* "Paid first session under
   a guarantee" is about trying a tutor you have not met, and a refill is always
   "exactly one session delivered", the shape `claimGuarantee` accepts
   (`purchase.ts:396-400`). Today that refunds a one-off with a tutor the student
   already knows, and widening the refill makes it available all term. *Strongest
   alternative:* leave it as is. The exposure is one claim per student, ever, under
   the current code, so the cost is bounded at one session's tutor pay plus processing.
