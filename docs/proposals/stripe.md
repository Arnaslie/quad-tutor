# Proposal: wiring Stripe (test mode first)

Status: **approved 2026-10-09.** Entries copied into `docs/decisions.md`; build per the checklist. Refreshed 2026-10-09 against
`main` at 213b6f6; it replaces the 2026-10-02 draft. Once approved, the entries in
[Draft decisions.md entries](#draft-decisionsmd-entries) are copied into
`docs/decisions.md` and the checklist below becomes one branch/PR per item.

Settled and not re-opened here (see `docs/decisions.md`): Connect Express in the MVP;
KYC deferred to the first accepted request; package purchase is deferred revenue; tutor
pay held until earned; charge only after accept + slot pick; unused sessions refund at
term end or when the student ends the package; the take is 10% capped at $100 per tutor
per term, fixed at recognition; the platform absorbs card processing and Connect fees;
the first-session guarantee is gone.

---

## What exists today

| Piece | Where | State |
|---|---|---|
| Charge seam, package (deck ask and renewal ask) | `src/server/modules/engagements/purchase.ts:160` | Comment **truncated** ("A failed"). Engagement, session and `package_purchase` written synchronously in one transaction holding `tutor_profile` then `match_request`. |
| Charge seam, one more session | `purchase.ts:254` | Also **truncated** ("same as"). Holds `tutor_profile`; gated by `bookAgain` (`reads.ts:258`). |
| Refund seam, term end and end early | `src/server/modules/engagements/termEnd.ts:163` | `closeWithRefund` (`:86-184`) writes one `refund` row for `price − delivered × per-session` with the engagement locked `for update`. Shared by the sweep (`runTermEndRefunds`, `:202`) and `endPackage` (`:186`). The sweep holds an engagement while any session could still settle. |
| Recognition and take meter | `src/server/modules/engagements/confirmation.ts:25-80` | `recognise()` locks the tutor, reads the meter (`ledger.ts:8-28`) and writes `session_earned`, `tutor_payout`, `platform_fee`. A payable, not a transfer. |
| Earnings | `src/server/modules/tutoring/earnings.ts:58-60` | `transferredMinor = 0`; the TODO comment at `:58` is **truncated** too. Cap progress at `:73-84`. |
| Ledger | `src/server/modules/billing/ledger.ts:30-77` | Typed rows; `balanceFor()` sums by type. `stripe_reference` is accepted but never set. |
| Schema | `src/server/db/schema.ts:161-162` (`stripe_account_id`, `kyc_status`), `:527` (`stripe_reference`, no index), `:90-97` (ledger types), `:61-73` (engagement and session statuses), `:431` (`guarantee_used`, history only) | `institution_id` is `NOT NULL` on `engagement` (`:411`), `session_booking` (`:449`) and `ledger_entry` (`:517`). |
| Engagement uniqueness | `schema.ts:439` | `unique(match_request_id)`: an abandoned checkout would block a retry. |
| "Is this request bought?" | `purchase.ts:137-144`, `reads.ts:343-354`, `messaging/threads.ts:52-56` | All three test "an engagement exists for this request", so a released checkout would hide the accepted request and close the thread. |
| Renewal trials | `src/server/modules/scoring/stats.ts:40-49` | `pairs` counts every engagement of a pair, so an abandoned checkout would read as a first engagement or a renewal. |
| Sweep | `src/app/api/cron/route.ts`, `.github/workflows/cron.yml` (every 15 min, `maxDuration = 60`, runs never overlap) | Per-campus jobs each have their own `catch`. Reads also call sweeps opportunistically (`reads.ts:161`). |
| Env | `.env.example:12-15` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. No SDK, no webhook route, no onboarding UI. |
| Payments in research | `docs/research/05-architecture-v2-campus.md` §3.2, §3.4-3.5, `02-architecture.md` §3.6, `06-ux-v2-campus.md` §5.3, §9.2 | Separate charges and transfers (`05-…:221`); hold the first transfer to the guarantee window (`:238`, moot); hide tutors without payouts from decks (`:528`). |

The two truncated `TODO(stripe)` comments in `purchase.ts` and the one in `earnings.ts`
are still there. They are not fixed separately: items 2 and 6 replace those lines. The
guarantee bugs the old draft listed went with the guarantee.

---

## 1. Charge flow shape

**Recommend: hosted Stripe Checkout Session, purchase is a pending state confirmed by
fulfilment.** All three purchases use it: a deck package, a renewal package (both
`purchasePackage`, after the accept) and one more session (`purchaseTopUp`, no accept).

- The server action creates the pending rows, commits, creates a Checkout Session
  (`mode: payment`, card only so `complete` always means paid; Apple/Google Pay ride on
  card), then `redirect()`s to `session.url` (Next 16's `redirect` takes absolute URLs,
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md:55`).
  No client Stripe JS, no publishable key.
- `expires_at = now + 30 min` (Stripe's minimum). The slot is held for that long.
- `metadata` and `payment_intent_data.metadata` carry `engagement_id` and
  `institution_id`; `payment_intent_data.transfer_group = engagement_id`. The amount
  comes from the engagement row (`pricing.ts`), never from the client.
- No Stripe Customer object yet (`customer_email` prefilled).

*Alternative: PaymentIntent + Payment Element.* Keeps the student on our page. Rejected
for MVP: client Stripe code, a publishable key, and our own expiry (PaymentIntents never
expire). Embedded Checkout is a later swap that keeps the Session, webhook and fulfilment.

**Rows while pending.** The purchase transaction keeps its locks and checks and writes:

- `engagement` with new status `pending_payment`, plus `stripe_checkout_session_id`
  (unique, null until stamped) and `checkout_expires_at`.
- `session_booking` with new status `held`. `availableSlots()` and `remainingCount`
  exclude only `cancelled` (`slots.ts:56`, `reads.ts:227-231`), so `held` blocks the slot
  and counts as booked with no change there, while every read, reminder, confirmation
  sweep and booking email keyed on `scheduled` ignores it.
- **No ledger row.**

After commit: create the Session (idempotency key `checkout:<engagement_id>`), then stamp
its id. If the create call fails, release at once.

**Fulfilment** is one idempotent function, `fulfilCheckout(engagementId)`, reached only
from Stripe's word: the `checkout.session.completed` webhook, or `syncCheckout`, which
**retrieves** the Session from Stripe. `syncCheckout` runs from the sweep, from the
`success_url` page (`/sessions?package=<id>`, already where the actions land) and from the
student's own sessions read. The redirect itself proves nothing.

It locks the engagement, returns unless `pending_payment`, checks `amount_total ===
price_paid_minor` and currency, then flips engagement → `active`, booking `held` →
`scheduled`, and writes `package_purchase` (`pi_…`) and `processor_fee` (`txn_…`). A
**unique partial index on `ledger_entry.stripe_reference`** makes a double fulfilment
fail in the database. An amount mismatch does not fulfil: it refunds and raises a
discrepancy (§7). A checkout paid in the minutes after term end is fulfilled as normal
and the term-end sweep refunds it in full.

**Abandoned / expired.**

- `cancel_url` expires the Session and releases the hold.
- `checkout.session.expired` → release: engagement and booking `cancelled`.
- `syncPendingCheckouts()` in the sweep: `pending_payment` past `checkout_expires_at + 2
  min` → retrieve and act on Stripe's answer (`complete` → fulfil, `expired` → release,
  `open` → expire, then release). Release only ever follows Stripe saying the Session is
  dead, so a payment never lands on a released slot.
- `engagement_match_request_idx` becomes **partial, `where status <> 'cancelled'`**, and the
  three "is this request bought?" checks above ignore `cancelled` engagements. The
  early-return at `purchase.ts:137-144` returns the live pending checkout if there is one.
- `bookAgain` (`reads.ts:281`, `:307`) treats `pending_payment` like `active`, so a pair
  mid-checkout for a package is not offered another; a pending refill leaves nothing to
  book, so refills still chain. `stats.ts` `pairs` counts only `active`, `completed` and
  `refunded` engagements.

## 2. Funds flow

**Recommend: separate charges and transfers** (`05-architecture-v2-campus.md:221`), each
transfer created with `source_transaction` = the engagement's charge.

Destination charges and `on_behalf_of` need an onboarded connected account at charge
time, and KYC is deferred past the first accept, so students would routinely pay tutors
with no account yet. They also move money to the tutor before it is earned. The take cap
makes this sharper: the split is unknown at purchase and only fixed per session at
recognition, which an `application_fee_amount` set at charge time cannot express.

`source_transaction` lets transfers go before the charge settles into the platform
balance, and `transfer_group` makes per-engagement reconciliation one list call. Per
engagement, transfers ≤ `tutor_payout` ≤ recognised ≤ price − refunds, so a transfer never
exceeds the charge it draws on (verify Stripe's exact `source_transaction` limit in item 6).

**Ledger → Stripe mapping**

| Ledger type | Written when | Stripe object | `stripe_reference` |
|---|---|---|---|
| `package_purchase` | fulfilment (package, renewal, refill) | PaymentIntent | `pi_…` |
| `processor_fee` *(new)* | fulfilment | Charge's balance transaction | `txn_…` |
| `session_earned`, `tutor_payout`, `platform_fee` | `recognise()` | none | null |
| `tutor_transfer` *(new)* | transfer sweep, before the call | Transfer | `tr_…`, stamped after |
| `transfer_reversal` *(new)* | `transfer.reversed` webhook (ops action) | Transfer reversal | `trr_…` |
| `refund` | `closeWithRefund` (term end, end early), amount mismatch | Refund | `re_…`, stamped after |
| `guarantee_absorbed` | never again; history only | — | — |

The take meter never reaches Stripe. The platform keeps what it does not transfer, and
the transfer is `Σ tutor_payout`, so past the cap a tutor is sent the full session price
and processing is the platform's cost, as decided.

`tutor_payout` is renamed `tutor_accrued` in item 1 (decided). In Stripe a payout moves a
connected balance to a bank; this row only records pay owed, so the old name invites
summing it as money sent. The migration is one `ALTER TYPE ... RENAME VALUE` plus the call
sites `confirmation.ts:67`, `earnings.ts:51` and `ledger.ts:75`. This doc uses today's
name elsewhere.

## 3. Stripe calls and locks, payouts, refunds

**No Stripe call while a row lock is held.** Every Stripe-side movement follows one shape:

1. **Decide under the lock.** The locked transaction writes the ledger row the decision
   creates, with `stripe_reference` null. The ledger records what is owed the moment it
   is owed, atomically with the state change.
2. **Call after commit.** From `after()` in the action (as messaging already does,
   `src/app/messages/actions.ts:33`) and from the sweep, with idempotency key
   `<type>:<ledger_entry_id>` and the row id in the object's metadata.
3. **Stamp.** `update … set stripe_reference = $1 where id = $2 and stripe_reference is
   null`. That is the one permitted update to a ledger row: a null reference filled once.
   Amounts are never edited.

A retry within 24h reuses the key. Stripe may drop a key after 24h, so a row older than
that first lists the PaymentIntent's refunds, or the `transfer_group`'s transfers, by
metadata before creating. A row still unstamped after a day is a discrepancy (§7).

New lock-order rows (no lock is taken while a Stripe call is in flight):

| Path | Order |
|---|---|
| `fulfilCheckout`, release | `engagement` (for update), then its `held` `session_booking` rows |
| transfer sweep | `engagement` (no key update) only |
| stamp | none; the conditional update is the guard |

Fulfil and release share the term-end shape and only touch `pending_payment` engagements,
which `recognise()` never reaches. The transfer sweep holds one row, so it can wait but
cannot deadlock.

**Refunds.** Both paths are `closeWithRefund`, which already refunds only undelivered
sessions, so no refund ever needs a transfer reversal or touches the meter. The student
sees the refund on screen at once; the card refund follows after commit. Engagements
bought before Stripe (no `pi_` on their purchase) are skipped.

**Transfers: in the sweep, per engagement, when the tutor's `kyc_status = 'verified'` and
the engagement has no open discrepancy or dispute.** Amount = `Σ tutor_payout − Σ
tutor_transfer` (pending rows included, so nothing is sent twice). Bounded to ~50 per run
against `maxDuration = 60`. `earnings.transferredMinor` becomes stamped `tutor_transfer −
transfer_reversal`. No clearing hold: the 24h confirmation window already gates the
accrual, and nothing claws session 1 back any more.

*Alternative: transfer inline on confirm.* Rejected: a Stripe call in the settle
transaction, and auto-release happens in the sweep anyway.

**Bank payouts** (connected balance → bank): **daily automatic** (decided). Cash is
immediate, so pay that waits a week is a reason to go off-platform. The schedule is set to
`daily` at account creation. Funds reach the bank about two business days after they are
available. The platform absorbs the standard Connect payout fee, as decisions.md already
says for Connect fees. Instant Payouts were considered and dropped: daily is fast enough,
and Instant adds a per-payout fee and a pricing setup.

Transfer reversals are an ops tool only; no code path issues one.

## 4. Connect onboarding and KYC timing

**Recommend: accepting a request is never blocked by KYC. Money waits, the student
doesn't.**

- Before the first accept: no Stripe account. The tutor appears in decks. (The research's
  "exclude tutors without payouts from decks" at `05-…:528` would stop the first accept
  that triggers onboarding. Not adopted.)
- On first accept, after the accept commits, the tutor is sent to `/tutor/payouts`, which
  creates the Express account if `stripe_account_id` is null (key
  `connect-account:<tutor_profile_id>`, `transfers` capability, `business_type:
  individual`, product description prefilled), then an Account Link. `return_url`
  re-retrieves the account; `refresh_url` mints a fresh link.
- Until verified: purchases, sessions, attendance and the meter all work; accruals wait;
  the tutor sees "Owed $X — finish payout setup to receive it" beside earnings on
  `/tutor/sessions`. Once verified, the next sweep transfers everything owed.
- `account.updated` re-retrieves the account and maps it with a pure function onto the
  existing enum (`schema.ts:28-33`): no account → `not_started`; submitted but `transfers`
  inactive → `pending`; `transfers` active and `payouts_enabled` → `verified`; a
  `disabled_reason` or past-due requirements → `restricted`, which pauses transfers and
  shows a fresh Account Link.

Never blocking accepts is decided. A gate before the second accept would cap what the
platform holds for an unverified tutor. It would also give that tutor a reason to take
cash from the student instead. Owed pay is a liability, not a loss.

## 5. Webhook route and security

- **Path:** `src/app/api/stripe/webhook/route.ts`, `POST` only; logic in
  `src/server/modules/billing/webhook.ts`.
- **Raw body:** `await request.text()` into `stripe.webhooks.constructEvent`. Next 16's
  route docs show this for webhooks and say no body-parser config is needed
  (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:559-597`);
  the body reads once (`…/02-guides/backend-for-frontend.md:347`). There is no
  `proxy.ts`; if one is added, Next buffers the body for it up to
  `proxyClientMaxBodySize` (10MB default), so the raw body still reaches the handler.
  Node runtime.
- **Two secrets.** Connect events come from a separate endpoint with its own secret. The
  route tries `STRIPE_WEBHOOK_SECRET` then `STRIPE_CONNECT_WEBHOOK_SECRET` (new).
- **Reject** a bad signature (400) and an event whose `livemode` doesn't match the key.
- **Handled events:** `checkout.session.completed`, `checkout.session.expired`,
  `charge.refunded` (stamps a refund row if the after-commit step died), `transfer.created`
  (same, for transfers), `transfer.reversed`, `account.updated`,
  `charge.dispute.created` / `charge.dispute.closed` (record the dispute with its
  timestamps, pause that engagement's transfers, alert ops). Everything else gets 200.
- **Duplicates and order:** every handler is a guarded state transition or a stamp onto a
  row found by the metadata id, plus the unique `stripe_reference`. No processed-event
  table. Handlers check current state or re-retrieve the object; a stale payload never
  overwrites newer state.
- Handler errors return 500 so Stripe retries. Nothing depends on the webhook arriving.
- Pin the SDK's `apiVersion` and register endpoints at the same version.
- In `/api/cron`, each Stripe sweep gets its own `catch`, like the per-campus jobs.

**No Stripe event writes a reliability fact in this build** (see Decisions taken, 4). A
checkout decline isn't a missed obligation: nothing was booked, and the student retries on
the same page.

## 6. Environments and testing

**One gateway module, two drivers.** `src/server/modules/billing/stripe.ts` is the only
file that imports `stripe`. It exposes the calls we make (create/retrieve/expire checkout,
refund, list refunds, transfer, list transfers, create account, account link) and a
**fake driver** in the pattern of the email and proof-store fallbacks
(`notifications/email.ts:55-58`, `tutoring/proof-store.ts:72-74`):

- Selected only by explicit `STRIPE_FAKE=1`; refused when `VERCEL_ENV === "production"`
  (`NODE_ENV` is `production` on previews too). The real driver refuses an `sk_live_` key
  unless `VERCEL_ENV === "production"`.
- The fake's checkout URL is `GET /api/dev/checkout/[id]?outcome=pay|expire`, which builds
  the event, signs it with `STRIPE_WEBHOOK_SECRET` (`generateTestHeaderString`), POSTs it
  to the real webhook route, then redirects. Verification, idempotency and fulfilment run
  for real.
- Fake accounts verify instantly; fake fees use 2.9% + 30¢.

| Environment | Keys | Webhooks |
|---|---|---|
| Local | `sk_test_` in `.env.local`, or `STRIPE_FAKE=1` | `stripe listen --forward-to localhost:3000/api/stripe/webhook --forward-connect-to localhost:3000/api/stripe/webhook` |
| Neon-branch previews | `sk_test_` in Vercel Preview | **None.** Return page and reads sync with Stripe. |
| CI (`npm test`; e2e on `test/daily-workflows`) | `STRIPE_FAKE=1`, a random `STRIPE_WEBHOOK_SECRET` per job | Fake posts signed events |
| Production | `sk_test_` until launch, then `sk_live_` | Two endpoints (platform + Connect) |

The tests that buy today (`renewal.test.ts`, `end-package.test.ts`, `ratings.test.ts`,
`messaging.test.ts`) and `db:demo` (`src/server/db/demo.ts:324`, `:428`) call the purchase
functions and expect an active engagement. They move to one helper that buys and pays
through the fake. **CI makes zero Stripe calls.** Tests cover buy → booked for all three
purchases, abandon → retry, end early and term end through the fake refund, a transfer
past the cap, and duplicate signed events. The invariant check (§7) runs after the suite.

*Alternative: drive real test-mode Checkout with 4242 cards.* Rejected: Stripe's hosted
pages resist automation, CI would need a public webhook URL, and load tests would hit the
test-mode rate limit.

Approved for later, once item 7 lands: one daily `stripe-smoke` job (~10 calls: confirm a PaymentIntent with
`pm_card_visa`, partial refund, transfer with `source_transaction` to a pre-made test
account). Needs a `STRIPE_TEST_SECRET_KEY` GitHub secret.

## 7. Money invariants and reconciliation

- Integer minor units end to end: Stripe `amount` comes straight from the engagement row;
  nothing divides except `perSessionMinor`/`splitMinor`/`unusedRefundMinor`, which floor
  in integers. Currency is lowercase `usd` on both sides.
- **Stripe is the truth for what moved; the ledger is the truth for what is owed.**
- **Database-only invariants** (CI and the daily sweep), per engagement: one
  `package_purchase` per non-pending, non-released engagement and none on the others;
  `refund ≤ package_purchase`; deferred `≥ 0`, and `0` once closed by a refund; per
  session, `session_earned = tutor_payout + platform_fee`; `tutor_transfer ≤ tutor_payout`.
  Per tutor and term, `Σ platform_fee ≤ 10000`.
- **Stripe reconciliation**, daily, for engagements with ledger activity in the last 7
  days or still pending: `package_purchase − refund` vs. the charge's `amount_captured −
  amount_refunded`; stamped `tutor_transfer − transfer_reversal` vs. `transfers.list({
  transfer_group })`; any row unstamped after a day. Bounded per run. Platform-wide
  (balance ≈ purchases − refunds − transfers + reversals − fees) is a monthly manual check.
- **On divergence:** write a `money_discrepancy` row (`institution_id`, engagement, kind,
  ledger amount, Stripe amount, detected/resolved timestamps), pause that engagement's
  transfers, list it on `/ops`. **Never auto-correct.** A human appends a corrective row
  referencing the Stripe object.

---

## Conflicts with invariants and decisions

- **decisions.md says "a single marked seam in `engagements/purchase.ts` where the
  PaymentIntent goes"** (Technical). This proposal replaces a synchronous charge with a
  pending state and fulfilment; the entry is rewritten below.
- **decisions.md calls the ledger "double-entry"**; it is typed single-sided rows summed
  by type. The wording changes in the same entry.
- **The lock-order table** gains three rows (§3). They fit its rules: nothing new holds a
  tutor, and nothing holds a lock across a Stripe call.
- **"Ledger rows are never edited"** is not written anywhere today, but everything assumes
  it. The stamp in §3 is the one exception and is recorded as such.
- **payments-engineer rule, "a chargeback is a timestamped fact"**: met by the dispute
  record; whether it also becomes a reliability fact is Decision 4.

## Where I'd push back on a settled decision

None. The research recommendations not adopted (holding the first transfer, hiding
unverified tutors from decks) are dropped because of settled decisions.

---

## Build checklist

Each item is one branch/PR and leaves the app runnable. The distributed-systems engineer
reviews items 2, 4 and 6 (idempotency, webhook, after-commit calls, sweeps).

| # | Item | Owner | Runnable result |
|---|---|---|---|
| 0 | DB-only invariant check (§7) as a script and a test helper | backend | Green on `db:demo` today |
| 1 | Migration: `engagement_status += pending_payment`; `session_status += held`; `engagement.stripe_checkout_session_id` (unique), `checkout_expires_at`; partial unique on `match_request_id`; ledger types `+= processor_fee, tutor_transfer, transfer_reversal`; rename `tutor_payout → tutor_accrued` (enum value and its 3 call sites); unique partial index on `stripe_reference` | database | Migrations apply, behaviour unchanged |
| 2a | Domain: pending purchase in `purchasePackage` and `purchaseTopUp`, `fulfilCheckout`, release, the three "is this request bought?" checks, `bookAgain` and `stats.ts` status filters, buy-and-pay test helper, `db:demo` | backend | Tests green with the fake |
| 2b | Gateway module (real + fake), `stripe` SDK, Checkout create/expire, `syncCheckout` and `syncPendingCheckouts`, webhook route (checkout events), `/api/dev/checkout` | payments | Full buy flow locally with `STRIPE_FAKE=1`, or test keys + `stripe listen` |
| 3 | Checkout UI: purchase panel and Book again redirect copy, "confirming payment" on return, cancel page, expired state | web | Polished flow on phone and desktop |
| 4 | Refunds through Stripe: after-commit issue and stamp for `closeWithRefund`, `charge.refunded` backstop, `processor_fee` | payments | End-early and term-end refunds visible in the test dashboard |
| 5 | Connect: account creation, Account Link, pure KYC mapping + tests, `account.updated`, Connect secret, daily payout schedule at creation, `/tutor/payouts` route | payments | Tutor can onboard with Stripe test data |
| 6 | Transfer sweep (never for an engagement whose `package_purchase` has no Stripe reference), `earnings.transferredMinor`, `transfer.created`/`transfer.reversed`, dispute events and pause | payments, with backend for `earnings.ts` | Owed → transferred after a confirmed session, past the cap too |
| 7 | Onboarding UI: post-accept prompt, `/tutor/payouts` page, owed-but-unverified and restricted banners on `/tutor/sessions` | web | End-to-end tutor money path |
| 8 | Reconciliation: `money_discrepancy` table (database), daily reconciliation (payments), `/ops` money list (web) | database → payments → web | Divergence visible and pauses transfers |
| 9 | `stripe-smoke` CI job, after item 7 | payments | Real adapter exercised daily |

---

## Manual steps only you can do

Never paste keys into chat or commits; nobody on the team handles them.

1. Create a Stripe account (test mode needs no business verification).
2. In test mode, enable **Connect**, choose **Express** accounts with the platform handling
   pricing, and set the Express branding tutors see during onboarding.
3. Copy the **test** secret key (`sk_test_…`) into `.env.local` as `STRIPE_SECRET_KEY`.
4. Install the Stripe CLI (`brew install stripe/stripe-cli/stripe`), `stripe login`, run
   the `stripe listen` command from §6 and put the printed `whsec_…` into `.env.local` as
   both `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. In Vercel, **Preview** scope only: `STRIPE_SECRET_KEY` = the test key. Leave the webhook
   secrets unset for previews.
6. When item 9 starts: add `STRIPE_TEST_SECRET_KEY` as a GitHub Actions secret and
   create one test connected account for it.
7. Before launch (not now): register the two production webhook endpoints and set live keys
   in Vercel Production only.

## Decisions taken

1. **Bank payouts:** daily automatic; no Instant Payouts (§3).
2. **Unverified tutors:** an accept is never blocked (§4).
3. **`stripe-smoke` job:** yes, after item 7 (item 9).
4. **Chargebacks:** recorded with timestamps; transfers pause; ops decides. No automatic
   `payment_failed` fact. A dispute can be fraud on a stolen card, a bank error or a real
   complaint, and an automatic fact could not be told apart from a genuine one.

5. **Ledger naming:** `tutor_payout` becomes `tutor_accrued` in item 1, so "payout"
   keeps its Stripe meaning (§2).

---

## Draft decisions.md entries

*Replaces "Stripe is settled for the MVP but absent from the first draft" under
Technical:*

> **Stripe is wired through hosted Checkout, and a purchase is pending until paid.**
> Buying a package, a renewal or one more session writes an engagement in
> `pending_payment` and a `held` session that blocks the slot, and no ledger row. One
> idempotent fulfilment, reached from the webhook or from asking Stripe (the return page,
> the student's reads, the sweep), flips both live and writes `package_purchase` against
> the PaymentIntent. A redirect is never proof of payment. A checkout is released only
> after Stripe says it is dead, so a payment can never land on a released slot. A released
> checkout is `cancelled` and counts as nothing: not a purchase, not a trial, not a
> renewal. The ledger is typed single-sided rows summed by type, not double-entry.

> **Separate charges and transfers, each transfer bound to its charge.** Destination
> charges need an onboarded tutor at charge time, KYC is deferred past the first accept,
> and the take is only known per session at recognition. Transfers carry
> `source_transaction` and `transfer_group = engagement_id` and send `Σ tutor_payout`; the
> take meter never reaches Stripe. The ledger owns what is owed; Stripe owns what moved;
> `stripe_reference` is unique.

> **No Stripe call holds a row lock.** The locked transaction writes the ledger row with
> no reference; the call follows the commit with the row id as its idempotency key; the
> reference is stamped once, conditionally. That stamp is the only update a ledger row
> ever takes. Lock order adds: fulfil and release take the engagement (for update), then
> its held sessions; the transfer sweep takes the engagement (no key update) alone.

> **Tutor pay moves in the sweep, not inline, and is never clawed back by code.**
> Transfers go per engagement once the tutor is verified and the engagement has no open
> discrepancy or dispute. Refunds return only undelivered sessions, so none needs a
> reversal. Bank payouts are daily. Reversals are an ops tool.

> **KYC never blocks an accept.** An unverified tutor's pay accrues and
> waits, and the student's sessions proceed. Hiding unverified tutors from decks was
> rejected: they would never get the accept that triggers onboarding.

> **A chargeback is recorded, not judged.** It pauses that engagement's
> transfers and goes to ops; it writes no reliability fact on its own.

> **CI and local dev run on a signed fake, not Stripe.** One gateway module is the only
> importer of `stripe`. Its fake signs real webhook events with the configured secret, so
> verification and idempotency are tested with no Stripe secret in CI. It is refused in
> production, like the email and proof-store fallbacks.

> **Ledger and Stripe are reconciled daily and never auto-corrected.** A divergence pauses
> transfers for that engagement and goes to `/ops`. It is fixed by appending a row that
> references the Stripe object.
