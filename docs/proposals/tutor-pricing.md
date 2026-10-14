# Proposal: tutor-set rates and a lower take after 10 sessions

Status: **proposal, not started; every question answered.** Written 2026-10-14 against
`origin/main` at `701a296`. Nothing in `docs/decisions.md` changes until this is
accepted. The replacement text is in its own section.

## The items

Decided by the user on 2026-10-14, and taken as input here:

1. Tutors set their own session rate. The fixed $35 price
   (`decisions.md:79-80`, `SESSION_PRICE_MINOR` in `billing/pricing.ts:1`) goes.
   Rates fall between $25 and $50 a session.
2. The platform's cut drops from 10% to 3% once a tutor has completed 10 sessions.

These two items ship as separate PRs, and rates go first. Both need the
`decisions.md` edit merged before the build.

## What exists today

- **The price a student paid is already locked in.** `engagement.price_paid_minor`
  (`schema.ts:448`) stores what was charged. `perSessionMinor` (`pricing.ts:93`)
  derives each session's value from it. `recognise()`
  (`engagements/confirmation.ts:25-51`) and `unusedRefundMinor` read that, never the
  constant. A rate change can therefore never re-price a package someone has bought.
- **Only quoting reads the constant.** `packageOptions()` and `topUpOption()`
  (`pricing.ts:35-67`) build every price shown to a student from
  `SESSION_PRICE_MINOR`. Those two functions, and their callers, are the whole change
  for rates.
- **Recognition already locks the tutor.** `recognise()` takes `tutor_profile`
  `for no key update` before it reads the term meter. A count of the tutor's earlier
  sessions read under the same lock cannot race.

## Rates

- **Where the rate lives.** One rate per (tutor, course), decided by the user on
  2026-10-14. A new `tutor_course.session_rate_minor` integer column,
  `NOT NULL DEFAULT 3500`. The column is additive, and every existing claim keeps
  today's $35. A tutor can charge more for Organic than for Calc I, and the rate sits
  on the core relationship (CLAUDE.md, Invariants).
- **Changing the rate.** A tutor can change a course's rate at any time, mid-term
  included, decided by the user on 2026-10-14. The change applies to new requests
  and new top-ups only.
- **Bounds.** $25.00 to $50.00, whole dollars only. The rule lives in its own
  import-free module, shared by the tutor's settings form and the server action
  (CLAUDE.md, Conventions). The server validates with Zod.
- **Packages scale from the rate.** `packageOptions(rateMinor)` and
  `topUpOption(rateMinor)` take the rate as an argument. Exam-anchored is 4 × rate.
  Through-final is 8 × rate less 10%, floored as today. A top-up is 1 × rate.
- **When a price is fixed.** The tutor sees the requested package before accepting,
  and checkout is locked to it (`docs/proposals/direct-renewal.md`). The quote is
  fixed at that accept and stored on the request. A rate change after the accept
  applies to new requests only. A top-up books straight into an open slot with no
  accept, so it is charged at the tutor's rate when checkout is created.
- **The student sees the rate.** It shows on the tutor card and the package choice.
  It is a fact about the pair, not ranker arithmetic, so it may cross to the client
  (CLAUDE.md, Invariants).
- **The rate is not a ranking input.** A cheaper tutor does not rank higher. Price
  competition on a peer campus would push rates down to the floor and say nothing
  about who teaches the course well.

## The lower take after 10 sessions

- **The rule.** A tutor's first 10 paid sessions take 10%. From the 11th onward, the
  take is 3%, decided by the user on 2026-10-14.
- **What counts.** Delivered, recognised sessions: a `session_earned` row for that
  `tutor_profile`, across all courses and all terms. The count is lifetime. A per-term
  count would reset each term and overlap with the cap, which is already the per-term
  reward.
- **Computed from the ledger, never a counter.** `recognise()` counts the tutor's
  earlier `session_earned` rows under the lock it already holds, and picks the rate.
  This follows the cap's own rule, a sum over the ledger rather than a counter that
  can drift (`decisions.md:93-95`).
- **Fixed once written.** A session's fee never changes after recognition. Reaching
  10 does not re-price earlier sessions.
- **The cap stays.** $100 per tutor per term, unchanged. The 11th-session rate only
  changes how fast a tutor reaches it.
- **Rounding.** `fee = min(floor(session × rateBp / 10000), max(0, 10000 − meter))`,
  where `rateBp` is 1000 or 300. Floor still rounds in the tutor's favour.
- **The tutor sees progress.** The earnings page shows "3 of 10 sessions to a lower
  fee", then the lower rate once it applies. No student sees it, the same as the cap
  meter.

### What it adds up to

At 3% after the 10th session, and one term:

| Rate | 1 session, tutor keeps | 10 sessions | Cap reached on |
|---|---|---|---|
| $25 | $22.50 | $225.00 | 110th session |
| $35 | $31.50 | $315.00 | 72nd session |
| $50 | $45.00 | $450.00 | 44th session |

At $35, 32 sessions pay the tutor $1,061.90 and the platform $58.10.

**The platform loses money on each session after the 10th.** At 3%, a $35 session
takes $1.05, and card processing costs about $1.10 a session
(`decisions.md:146-148`). At $25 the take is $0.75. The user chose 3% on
2026-10-14 after this was raised. The lower take is the reason to stay on the app past the 10th session,
the same lever as the cap. In practice the cap is now only reached by a tutor on a
high rate with a heavy term.

## Replacement text for `docs/decisions.md`

Replace the first paragraph under "The take is 10% of each session, capped at $100 per
tutor per term" (`decisions.md:79-86`) with:

> **Tutors set their own rate for each course they tutor, between $25 and $50 a
> session. The take is 10% of each of a tutor's first 10 sessions and 3% after,
> capped at $100 per tutor per term.** The
> student pays the tutor's rate and nothing on top: a student booking fee was rejected
> because the student is already paying for the tutor. The price is fixed when the
> tutor accepts the request, or when a top-up's checkout is created, and a later rate
> change never re-prices it. Once a tutor's platform share for a term reaches $100, they
> keep 100% for the rest of that term. At $35 a session the cap is reached on the 72nd
> session. The 10-session count is lifetime, across all courses, and is read from the
> ledger at recognition. A session's rate is fixed once it is written. The rate is shown
> to students and is never a ranking input.

The cap rules below that paragraph stay. Two examples in them name $35 and need
updating: "the 29th at $35 pays $2.00" and "caps on the 32nd" (`decisions.md:139-143`).

## PRs

1. This proposal and the `decisions.md` edit. You merge it.
2. Tutor-set rates. This has a schema migration, so merge-gate flags it and you merge
   it.
3. The lower take after 10 sessions. It changes the take, so merge-gate flags it and
   you merge it.

The test users for production have their own proposal. They are built on top of 2
and 3, so the earnings they show follow the real rules.
