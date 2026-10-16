# Lifetime fee milestone

Status: accepted 2026-10-16. The user settled the open questions the same day and asked
for the crossing session to be split at the $100 line. Built in two stacked PRs (Delivery).

## The rule

The platform takes 10% of each session until it has collected $100 in fees from a
tutor, counted over the tutor's whole life on one campus. After that it takes 5% of
every session, for good. The meter never resets at term end, and there is no 0% cap.

The same $100 opens the tutor's public ratings. It replaces the 10-delivered-sessions
gate. A course rating still needs 5 released ratings in that course, and the overall
rating still needs at least one public course rating.

This replaces three rules in `docs/decisions.md`: the 10-session step from 10% to 5%,
the $100-per-term cap, and the 10-session rating gate.

## What students see

Students see the same things as today: a rating ("4.7 · 12 ratings") or "New tutor".
The fee number never leaves the server. Only its effect crosses, which is whether the
rating shows. The 10-session gate already worked this way, so a rating showing has
always told a student that the tutor has some volume. The ranker (`score.ts`) does not
read fees, before or after this change.

Costs the user accepts with this rule:

- Price decides how fast a tutor is rated. The 29th session at $35, the 67th at $15,
  the 10th at $100, the 5th at $200.
- Busy tutors pay 5% forever instead of 0% past the cap. The cap was the main reason
  a busy tutor had nothing to gain from moving students to cash.

## Design

Nothing new is stored and there is no migration. The meter is the sum of the tutor's
`platform_fee` rows, read from the ledger, the way the cap was.

- `pricing.ts`: `FEE_MILESTONE_MINOR = 10_000` and `milestoneReached(feeToDateMinor)`,
  the only place "$100 reached" is decided. `splitMinor(sessionMinor, { feeToDateMinor })`
  calls it. `takeRateBp`, `TERM_FEE_CAP_MINOR` and `FULL_TAKE_SESSIONS` are deleted.
- `ledger.ts`: `feesToDate(exec, institutionId, tutorProfileIds)`, batched, the only
  definition of the meter. `feeChargedThisTermMinor` and `sessionsEarned` are deleted.
- `confirmation.ts`: `recognise()` reads `feesToDate` under the existing tutor lock.
  The lock order does not change.
- `ratings/rules.ts`: `publicRating(sum, count, feeToDateMinor)` calls
  `milestoneReached`. `MIN_SESSIONS` is deleted. `pricing.ts` imports nothing, so the
  client rating form still never reaches `db`.
- `ratings/reads.ts`: `cardRatings()` reads `feesToDate` in place of its session count.
  Same joins, same cost.
- `earnings.ts` and `tutor/sessions/page.tsx`: the tutor's card shows "$64.00 of
  $100.00" and the bar until the milestone, then "We take 5% of every session from now
  on, and your ratings show once a course has 5."

The session that crosses $100 is split at the line, like a tax bracket. The part of
the session whose 10% fee fills the meter up to exactly $100 is charged 10%. The rest
of the same session is charged 5%. With $98 already collected, a $35 session pays $2 on
its first $20 and $0.75 on the other $15: a $2.75 fee, and the meter ends at $100.75.

```
toLine     = 10_000 − feeToDate
fullFee    = floor(session × 10%)
if fullFee ≤ toLine:  fee = fullFee                          (below the line)
else:                 fee = toLine + floor((session − toLine × 10) × 5%)
past the line:        fee = floor(session × 5%)
```

It is still one `platform_fee` row per session, and one payment. The fee is never a
payment of its own: the student pays once at checkout, the platform keeps the fee in
the ledger, and the tutor's `tutor_accrued` share goes out in the usual transfer. There
are no invoices in the product. Two rows would break "one recognition per session"
for nothing, since the split is fully recomputable from the session amount and the
meter before it.

## db:check-money

Fees written under the old rule stay in the ledger and must keep passing.

- Kept: each fee is at most 10% of its session.
- Removed: "full take on at most 10 sessions" and "fee within the term cap".
- Added, per tutor: take the fees charged above 5%. Flag when their sum minus the
  largest of them is $100 or more. Fees only grow, so the last of those sessions saw
  a meter of at least that much. The crossing session's blended fee counts in that set,
  and the check still holds. It needs no row order and no rule date, and old rows pass
  it.

The other direction (5% charged too early) is not checked in the database, because old
rows break it by design. Tests prove it instead.

## Who changes at deploy

There is no transition code. Three groups change the moment this ships:

1. Tutors past this term's cap go from 0% to 5%. Their card promised "100% for the
   rest of the term".
2. Tutors past 10 sessions but under $100 lifetime go back up from 5% to 10%.
3. Tutors with a public rating but under $100 lifetime lose the rating until they
   cross.

Before merge, the user runs the new `db:check-money` and a read-only query against
prod that lists real (non-persona) tutors in any of the three groups. If the list is
empty, ship. If not, the user decides what to do for those people by hand.

## Delivery

Two stacked PRs.

1. `feat(billing): lifetime $100 fee milestone`. Pricing, ledger, `recognise()`,
   check-money, the tutor card, persona fee figures, the pricing section of
   `decisions.md`. This touches the take, so the user merges it.
2. `feat(ratings): gate public ratings on the fee milestone`. Rules, reads, tests,
   the `tutor-9` and `tutor-10` personas moved to $100 a session so 9 sessions is $90
   and 10 is exactly $100, and the ratings section of `decisions.md`.

## Rejected

- **Storing the crossing time on `tutor_profile`.** It saves no reads, since both
  callers already scan the same ledger rows. It needs a migration and a second owner
  of a ledger fact. Its check-money rule, "no fee above 5% after the crossing time",
  fails on old rows: a $200 tutor who hit last term's cap at $100 paid 10% again in
  the next term, after a backfilled crossing time.
- **Charging the whole crossing session at 10%.** Simpler, but the user chose the
  split: no fee above $100 is charged at 10%.
- **Storing the rate on each fee row.** It proves a row's arithmetic, not the policy.

## Settled by the user, 2026-10-16

1. The change stands for existing tutors in all three groups. No grandfathering.
2. If `FEE_MILESTONE_MINOR` is raised later, tutors between the old and new line go
   back to 10%. Accepted.
3. Rename the `tutor-capped` persona now that the cap is gone.
4. Split the crossing session at the $100 line, in one fee row.
