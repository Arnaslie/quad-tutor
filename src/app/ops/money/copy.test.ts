import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiscrepancyItem } from "@/server/modules/billing/ops";

import { disputeBody, explained, heldLine } from "./copy";

const item = (overrides: Partial<DiscrepancyItem>): DiscrepancyItem => ({
  id: "d1",
  kind: "ledger_vs_stripe_charge",
  stripeReference: null,
  refundReference: null,
  ledgerAmountMinor: 14_000,
  stripeAmountMinor: null,
  currency: "usd",
  detectedAt: new Date(0),
  ledgerEntryType: null,
  heldRefundMinor: null,
  engagement: null,
  canSettle: false,
  canResolve: true,
  paymentBooked: false,
  refund: null,
  ...overrides,
});

const RECORD = { label: "Record manual payment", pending: "Recording…" };

test("money taken with nothing booked says whether its refund went out, retries or failed", () => {
  const retrying = { kind: "checkout_amount", stripeReference: "pi_1", refund: "retrying" } as const;
  assert.deepEqual(explained(item(retrying)), {
    title: "Checkout took the wrong amount",
    body: "Stripe charged a different amount than the package costs, so the package was cancelled and the payment is refunded.",
    note: "The refund has not gone out yet and keeps retrying. Resolving stops the retries.",
    settle: null,
  });
  assert.deepEqual(explained(item({ ...retrying, refund: null, refundReference: "re_1" })).note, "Stripe has refunded it. Resolve this once you have checked.");
  const bounced = "Its refund failed at Stripe. Answer it on the failed refund card for this payment.";
  assert.deepEqual(explained(item({ ...retrying, refund: "failed", refundReference: "re_1" })).note, bounced);
  assert.deepEqual(explained(item({ stripeReference: "pi_1", refund: "failed", refundReference: "re_1" })).note, bounced);
  assert.deepEqual(explained(item({ stripeReference: "pi_1" })), {
    title: "Stripe took money no package booked",
    body: "The student paid, but no package on the ledger booked the payment, so the payment is refunded.",
    note: "Its refund failed and is not retried.",
    settle: null,
  });
});

test("a charge flag on a booked payment is the plain charge card", () => {
  assert.deepEqual(explained(item({ stripeReference: "pi_1", paymentBooked: true })), {
    title: "A charge does not match the ledger",
    body: "What Stripe kept for this payment, after refunds, is not what the ledger booked. Check the payment in the Dashboard.",
    note: null,
    settle: null,
  });
});

test("a Dashboard refund offers booking only while its refund row is unsent", () => {
  const dashboard = { stripeReference: "re_1", ledgerEntryType: "refund" } as const;
  assert.deepEqual(explained(item({ ...dashboard, canSettle: true, canResolve: false })), {
    title: "A refund was made in the Stripe Dashboard",
    body: "Someone refunded this payment in the Dashboard, so the package refund was stopped rather than sent a second time.",
    note: "Booking it records the Dashboard refund as the package refund. If the two amounts differ, the difference comes back as a flag on the payment.",
    settle: { label: "Book this Dashboard refund", pending: "Booking…" },
  });
  assert.deepEqual(explained(item(dashboard)), {
    title: "A refund was made in the Stripe Dashboard",
    body: "Someone refunded this payment in the Dashboard, so the package refund was stopped rather than sent a second time.",
    note: null,
    settle: null,
  });
});

test("a checkout Stripe could not find says nothing was charged", () => {
  assert.deepEqual(explained(item({ stripeReference: "cs_1" })), {
    title: "Stripe could not find a checkout",
    body: "Stripe said this checkout does not exist, so the package was let go. Nothing was charged on it.",
    note: "The reconciliation keeps asking Stripe, and clears this if the checkout turns up unpaid. If it turns up paid, the payment is refunded and this stays open for you to resolve.",
    settle: null,
  });
});

test("an unconfirmed row or checkout says when it clears and what happens if it was paid", () => {
  assert.deepEqual(explained(item({ kind: "unstamped_reference" })), {
    title: "Stripe has not confirmed a payment",
    body: "A refund or tutor transfer from over a day ago still has no Stripe id, or a checkout was let go before Stripe gave it one. This flag does not stop retries or pause the tutor's transfers.",
    note: "It clears itself once every row has its Stripe id, or a day after a checkout was let go if Stripe holds no payment for it. If the student did pay, the payment is refunded and this stays open for you to resolve.",
    settle: null,
  });
});

test("a flag on an unsent transfer says resolving would leave it unsent", () => {
  const transfers = { kind: "ledger_vs_stripe_transfers", ledgerEntryType: "tutor_transfer" } as const;
  assert.deepEqual(explained(item({ ...transfers, canSettle: true, canResolve: false })), {
    title: "Tutor pay does not match the ledger",
    body: "What Stripe sent the tutor for this package, after reversals, is not what the ledger booked, or Stripe refused a transfer.",
    note: "It stopped the transfer to the tutor, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.",
    settle: RECORD,
  });
  assert.deepEqual(explained(item({ kind: "ledger_vs_stripe_transfers" })).note, null);
});

test("a failed refund with no row of ours tells an unbooked payment from a Dashboard refund", () => {
  const failed = { kind: "refund_failed", stripeReference: "pi_1", canSettle: true } as const;
  const body = "Stripe could not return this money to the student's card, usually because the card is closed or lost. Nothing sends it to that card again.";
  assert.deepEqual(explained(item(failed)), {
    title: "A refund to the student failed",
    body,
    note: "It returned a payment no package booked. Nothing sends this money again, so pay the student another way, then record it.",
    settle: RECORD,
  });
  assert.deepEqual(explained(item({ ...failed, paymentBooked: true, refund: "holding" })), {
    title: "A refund to the student failed",
    body,
    note: "It was made in the Stripe Dashboard, so no refund row names it. It holds the package's refund so it is not sent to the same card. If you paid the student another way, record it, and the package refund waiting is marked paid and never sent. Resolving instead sends the package refund to the same card.",
    settle: RECORD,
  });
  assert.deepEqual(
    explained(item({ ...failed, paymentBooked: true })).note,
    "It was made in the Stripe Dashboard, so no refund row names it. The package has no refund waiting yet. Resolving or recording a manual payment both close this, and a refund the package owes later goes to the same card.",
  );
});

test("a refund that bounced after Stripe stamped it offers only resolving, while one refused unsent offers only recording", () => {
  const failed = { kind: "refund_failed", stripeReference: "pi_1", ledgerEntryType: "refund", canSettle: true, paymentBooked: true } as const;
  assert.deepEqual(explained(item({ ...failed, canResolve: true })), {
    title: "A refund to the student failed",
    body: "Stripe could not deliver the refund to the student, and nothing sends it again.",
    note: "Pay them another way, then resolve this with a note on how you paid.",
    settle: null,
  });
  assert.deepEqual(explained(item({ ...failed, canResolve: false })), {
    title: "A refund to the student failed",
    body: "Stripe could not return this money to the student's card, usually because the card is closed or lost. Nothing sends it to that card again.",
    note: "It stopped the refund to the student, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.",
    settle: RECORD,
  });
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
    "The sweeps are holding back 1 refund and 2 tutor transfers. This includes any held by a flag that was already resolved.",
  );
  assert.equal(heldLine({ refunds: 0, transfers: 1 }), "The sweeps are holding back 1 tutor transfer. This includes any held by a flag that was already resolved.");
  assert.equal(heldLine({ refunds: 0, transfers: 0 }), null);
});
