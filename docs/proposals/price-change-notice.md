# Proposal: tell the student when a tutor's price changed

Status: **accepted 2026-10-22.** Written 2026-10-22 against `origin/main` at
`b232597`.

## The item

Decided by the user on 2026-10-22: when the price a student is about to pay differs
from the price the tutor showed them earlier, the student is told. The rule in
`docs/decisions.md` (Product, "Tutors set their own rate") does not change. The price
is still fixed when the tutor accepts, or when a top-up's checkout is created.

## What exists today

- **Request flow.** The tutor list shows `tutor_course.session_rate_minor`. Sending a
  request stores no rate (`matching/requests.ts:163`). Accepting copies the tutor's
  current rate onto `match_request.quoted_rate_minor` (`requests.ts:266`), and checkout
  charges that. A rate change between send and accept reaches the student with no
  notice. The payment page shows the new amount, so nothing is hidden, but nothing
  says it moved.
- **Top-up.** The button shows a price rendered when the page loaded
  (`sessions/top-up.tsx:92`). `purchaseTopUp` reads the current rate when it creates
  the checkout (`engagements/purchase.ts:402`). A rate change while the page is open
  charges the new price under a button that shows the old one.
- Once a checkout exists, its price is on `engagement.price_paid_minor`, and a refresh
  resumes it. That part needs nothing.

## The change

### Request flow: show the change on the purchase panel

- Add `match_request.requested_rate_minor`, a nullable integer. `sendRequests` writes
  the tutor's current rate into it. Rows from before the column stay null and show no
  notice.
- When `quoted_rate_minor` differs from `requested_rate_minor`, the purchase panel
  shows one line above the package choice. For a raise: "Sam raised their price from
  $35 to $40 a session since you asked. You can still pick someone else." For a cut:
  "Sam lowered their price from $40 to $35 a session since you asked."
- The "said yes" email (`notifications/messages.ts`, `requestAccepted`) carries the
  same line when the rates differ, so the student hears about the change before they
  open the app.
- The tutor's accept screen shows the rate the student asked at, when it differs,
  so the tutor knows the student will see the change.

The column is additive and nullable, so it is safe while old code runs against the
new schema. It is a schema change, so the user merges it.

### Top-up: refuse a stale price

- The form posts the price it showed, as `shownPriceMinor`.
- `purchaseTopUp` compares it with `topUpOption(rate).priceMinor`. On a mismatch it
  creates no checkout and returns: "Sam's price changed to $40 a session. Check the
  new price and try again." The page re-renders with the new price.
- A resumed checkout skips the check: its price was fixed when it was created.

This is the same pattern as the cancel form, which posts the kept share it showed and
refuses when the server's tier differs (`decisions.md`, cancels). No schema change.

## Not in this change

- Locking the rate at send time, so the tutor's accept carries the price the student
  saw. That changes a settled rule and lets a tutor be held to a price they have since
  raised. Not proposed.
- A separate email the moment a tutor changes a rate. While a request is still
  pending the student has nothing to pay yet, and the tutor may never accept. The
  change reaches them in the "said yes" email and on the purchase panel.

## Delivery

Two PRs, each one concern.

1. Top-up stale-price check. No schema. pstack can merge it once the gate passes.
2. `requested_rate_minor` and the purchase panel notice. Schema, so the user merges.
