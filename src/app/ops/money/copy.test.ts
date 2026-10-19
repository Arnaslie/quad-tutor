import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiscrepancyItem } from "@/server/modules/billing/ops";

import { disputeBody, explained, heldLine, lastAnswer } from "./copy";

const item = (overrides: Partial<DiscrepancyItem>): DiscrepancyItem => ({
  id: "d1",
  kind: "ledger_vs_stripe_charge",
  stripeReference: null,
  refundReference: null,
  ledgerAmountMinor: 14_000,
  stripeAmountMinor: null,
  currency: "usd",
  detectedAt: new Date(0),
  row: null,
  held: [],
  lastAnswer: null,
  engagement: null,
  canSettle: false,
  canResolve: true,
  paymentBooked: false,
  refund: null,
  ...overrides,
});

const RECORD = [{ label: "Record manual payment", pending: "Recording…", heldRefundId: null }];

const refundRow = (amountMinor: number, reference: string | null = null) => ({
  id: "r1",
  type: "refund" as const,
  amountMinor,
  bookedAt: new Date(0),
  sessionAt: null,
  reference,
});
const heldRefund = (id: string, amountMinor: number, bookedAt = new Date(0), stoppedForGood = false) => ({ id, amountMinor, bookedAt, sessionAt: null, stoppedForGood });

test("money taken with nothing booked says whether its refund went out, retries or failed", () => {
  const retrying = { kind: "checkout_amount", stripeReference: "pi_1", refund: "retrying" } as const;
  assert.deepEqual(explained(item(retrying)), {
    title: "Checkout took the wrong amount",
    body: "Stripe charged a different amount than the package costs, so the package was cancelled and the payment is sent back.",
    note: "The refund has not gone out yet and keeps retrying. Resolving stops the retries.",
    settle: [],
  });
  assert.deepEqual(explained(item({ ...retrying, refund: null, refundReference: "re_1" })).note, "Stripe has refunded it. Resolve this once you have checked.");
  const bounced = "Its refund failed at Stripe. Answer it on the failed refund card for this payment, or resolve this if that card is already resolved.";
  assert.deepEqual(explained(item({ ...retrying, refund: "failed", refundReference: "re_1" })).note, bounced);
  assert.deepEqual(explained(item({ stripeReference: "pi_1", refund: "failed", refundReference: "re_1" })).note, bounced);
});

test("a charge flag on a booked payment is the plain charge card", () => {
  assert.deepEqual(explained(item({ stripeReference: "pi_1", paymentBooked: true })), {
    title: "A charge does not match the ledger",
    body: "What Stripe kept for this payment, after refunds, is not what the ledger booked. Check the payment in the Dashboard.",
    note: null,
    settle: [],
  });
});

test("a Dashboard refund offers booking only while its refund row is unsent", () => {
  const dashboard = { stripeReference: "re_1", row: refundRow(10_500) } as const;
  assert.deepEqual(explained(item({ ...dashboard, canSettle: true, canResolve: false })), {
    title: "A refund was made in the Stripe Dashboard",
    body: "Someone refunded this payment in the Dashboard, so this refund was stopped rather than sent a second time. Other refunds on this package wait until it is answered.",
    note: "Booking it records the Dashboard refund as this refund. If the Ledger and Stripe amounts on this card differ, settle the difference yourself.",
    settle: [{ label: "Book this Dashboard refund", pending: "Booking…", heldRefundId: null }],
  });
  assert.deepEqual(explained(item(dashboard)), {
    title: "A refund was made in the Stripe Dashboard",
    body: "Someone refunded this payment in the Dashboard, so this refund was stopped rather than sent a second time. Other refunds on this package wait until it is answered.",
    note: null,
    settle: [],
  });
});

test("a Dashboard refund that then failed offers no booking and sends ops to the failed refund card", () => {
  assert.deepEqual(explained(item({ stripeReference: "re_1", row: refundRow(10_500), canResolve: false, refund: "failed" })), {
    title: "A refund was made in the Stripe Dashboard",
    body: "Someone refunded this payment in the Dashboard, so this refund was stopped rather than sent a second time. Other refunds on this package wait until it is answered.",
    note: "That Dashboard refund then failed at Stripe, so the student did not get it. Pay them another way and record it on the failed refund card for this payment. Once that card is recorded, resolve this.",
    settle: [],
  });
});

test("a checkout Stripe could not find says Stripe found no payment on it", () => {
  assert.deepEqual(explained(item({ stripeReference: "cs_1" })), {
    title: "Stripe could not find a checkout",
    body: "Stripe said this checkout does not exist, so the package was let go. Stripe found no payment on it.",
    note: "The reconciliation keeps asking Stripe, and clears this if the checkout turns up unpaid. If it turns up paid, the payment is refunded and this stays open for you to resolve.",
    settle: [],
  });
});

test("an unconfirmed row or checkout says when it clears and what happens if it was paid", () => {
  assert.deepEqual(explained(item({ kind: "unstamped_reference" })), {
    title: "Stripe has not confirmed a payment",
    body: "A refund or tutor transfer from over a day ago still has no Stripe id, or a checkout was let go before Stripe gave it one. This flag does not stop retries or pause the tutor's transfers.",
    note: "It clears itself once every row has its Stripe id, or a day after a checkout was let go if Stripe holds no payment for it. If the student did pay, the payment is refunded and this stays open for you to resolve.",
    settle: [],
  });
});

test("a flag on an unsent transfer says resolving would leave it unsent", () => {
  const transfers = { kind: "ledger_vs_stripe_transfers", row: { ...refundRow(3_150), type: "tutor_transfer" as const } } as const;
  assert.deepEqual(explained(item({ ...transfers, canSettle: true, canResolve: false })), {
    title: "Tutor pay does not match the ledger",
    body: "What Stripe sent the tutor for this package, after reversals, is not what the ledger booked, or Stripe refused a transfer.",
    note: "It stopped the transfer to the tutor, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.",
    settle: RECORD,
  });
  assert.deepEqual(explained(item({ kind: "ledger_vs_stripe_transfers" })).note, null);
});

const BOUNCED = "Stripe could not return this money to the student's card, usually because the card is closed or lost. Nothing sends it to that card again.";
const DASHBOARD = "It was made in the Stripe Dashboard, so no refund row names it.";

test("a failed refund with no row of ours tells an unbooked payment from a Dashboard refund with nothing waiting", () => {
  const failed = { kind: "refund_failed", stripeReference: "pi_1" } as const;
  assert.deepEqual(explained(item(failed)), {
    title: "A refund to the student failed",
    body: BOUNCED,
    note: "It returned a payment no package booked. Nothing sends this money again, so pay the student another way, then resolve this with a note on how you paid.",
    settle: [],
  });
  assert.deepEqual(explained(item({ ...failed, paymentBooked: true })), {
    title: "A refund to the student failed",
    body: BOUNCED,
    note: `${DASHBOARD} Nothing on this package is waiting to be refunded. Check the payment's history in Stripe. If this money did not reach the student another way, pay them, then resolve this with how you paid. Until then, any refund the package owes is held back from this card.`,
    settle: [],
  });
});

test("a failed Dashboard refund offers one button per refund it holds, and says when one can only be paid by hand", () => {
  const failed = { kind: "refund_failed", stripeReference: "pi_1", paymentBooked: true } as const;
  const held = [heldRefund("h1", 875), heldRefund("h2", 9_625)];
  assert.deepEqual(explained(item({ ...failed, held, refund: "holding" })), {
    title: "A refund to the student failed",
    body: BOUNCED,
    note: `${DASHBOARD} It holds the package's refunds listed here, so none is sent to the same card. For each one you pay the student another way, record it on its button. Resolving sends the rest to the same card.`,
    settle: [
      { label: "Record $8.75 as paid by hand", pending: "Recording…", heldRefundId: "h1" },
      { label: "Record $96.25 as paid by hand", pending: "Recording…", heldRefundId: "h2" },
    ],
  });
  const stopped = [heldRefund("h1", 875), heldRefund("h2", 9_625, new Date(0), true)];
  assert.equal(
    explained(item({ ...failed, held: stopped, refund: "holding_stopped", canResolve: false })).note,
    `${DASHBOARD} It holds the package's refunds listed here, so none is sent to the same card. For each one you pay the student another way, record it on its button. Another flag has also stopped one of them for good, so that one can only be paid by hand.`,
  );
});

test("two held refunds of the same amount are told apart by when each was booked", () => {
  const twins = [heldRefund("h1", 875, new Date("2026-10-19T15:00:00Z")), heldRefund("h2", 875, new Date("2026-10-20T15:00:00Z"))];
  assert.deepEqual(
    explained(item({ kind: "refund_failed", stripeReference: "pi_1", paymentBooked: true, held: twins, refund: "holding" })).settle.map((c) => c.label),
    ["Record $8.75 from Mon, Oct 19 at 10:00 AM as paid by hand", "Record $8.75 from Tue, Oct 20 at 10:00 AM as paid by hand"],
  );
});

test("a refund that bounced after Stripe stamped it offers only resolving, while one refused unsent offers only recording", () => {
  const failed = { kind: "refund_failed", row: refundRow(10_500, "re_1"), canSettle: false, paymentBooked: false } as const;
  assert.deepEqual(explained(item({ ...failed, ledgerAmountMinor: 10_500, canResolve: true })), {
    title: "A refund to the student failed",
    body: "Stripe could not deliver the refund to the student, and nothing sends it again.",
    note: "The package owes them $105.00. Pay them that another way, then resolve this with a note on how you paid.",
    settle: [],
  });
  assert.deepEqual(explained(item({ ...failed, row: refundRow(10_500), canSettle: true, canResolve: false })), {
    title: "A refund to the student failed",
    body: BOUNCED,
    note: "It stopped the refund to the student, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.",
    settle: RECORD,
  });
});

test("a reopened flag shows ops' last answer word for word, and a flag never answered shows none", () => {
  const reopened = { kind: "refund_failed", stripeReference: "pi_1", paymentBooked: true } as const;
  assert.equal(lastAnswer(item({ ...reopened, lastAnswer: "retrying in the Dashboard" })), "Last answer: retrying in the Dashboard");
  assert.equal(lastAnswer(item({ ...reopened, lastAnswer: "<b>paid</b> & done" })), "Last answer: <b>paid</b> & done");
  assert.equal(lastAnswer(item({ kind: "refund_failed", stripeReference: "pi_1" })), null);
});

test("a booked Dashboard refund that bounced says what its row owes, not what the Dashboard refunded", () => {
  assert.equal(
    explained(item({ kind: "refund_failed", row: refundRow(10_500, "re_dash"), ledgerAmountMinor: 5_000 })).note,
    "The package owes them $105.00. Pay them that another way, then resolve this with a note on how you paid.",
  );
});

test("a dispute card says what lifting the pause pays out", () => {
  assert.equal(
    disputeBody(true),
    "Stripe has closed it. Lifting the pause lets the tutor's pay on this package go out again, unless something else holds it. If they should not be paid, leave it paused.",
  );
  assert.equal(
    disputeBody(false),
    "Stripe has not closed it, so the bank is still deciding. Transfers to the tutor on this package stay paused, and you can lift the pause once it closes.",
  );
});

test("the held line counts what the sweeps hold back, and is gone when they hold nothing", () => {
  assert.equal(
    heldLine({ refunds: 1, transfers: 2 }),
    "The sweeps are holding back 1 refund and tutor pay on 2 packages. This includes any held by a flag that was already resolved.",
  );
  assert.equal(heldLine({ refunds: 0, transfers: 1 }), "The sweeps are holding back tutor pay on 1 package. This includes any held by a flag that was already resolved.");
  assert.equal(heldLine({ refunds: 0, transfers: 0 }), null);
});
