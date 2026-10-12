import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, moneyDiscrepancy, sweepLease } from "@/server/db/schema";
import { endPackage } from "@/server/modules/engagements/termEnd";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { settleCheckout } from "./checkout-session";
import { assertMoneyInvariants } from "./invariants";
import { runReconciliation } from "./reconcile";
import { blockedRefunds, refundThroughStripe } from "./refunds";
import { fakeStripe, stripeGateway } from "./stripe";
import { accepted, checkingOut, cleanup, deliver, delivered, noStripe, patched, rows, world, type World } from "./test-world";
import { runTransfers } from "./transfers";

const reconcile = (w: World) => runReconciliation(w.institutionId, Date.now() + 10_000);
const counts = (checked: number, flagged = 0, resolved = 0) => ({ checked, flagged, resolved, failed: 0 });

async function flags(institutionId: string) {
  return db
    .select({
      kind: moneyDiscrepancy.kind,
      engagementId: moneyDiscrepancy.engagementId,
      ledgerEntryId: moneyDiscrepancy.ledgerEntryId,
      stripeReference: moneyDiscrepancy.stripeReference,
      ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor,
      stripeAmountMinor: moneyDiscrepancy.stripeAmountMinor,
      resolutionNote: moneyDiscrepancy.resolutionNote,
    })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.institutionId, institutionId))
    .orderBy(moneyDiscrepancy.detectedAt);
}

/** Moves the campus a day on: the engagement is due again and the daily pass may run again. */
async function aDayLater(w: World, engagementId?: string) {
  const dayAgo = new Date(Date.now() - 25 * 3_600_000);
  if (engagementId) await db.update(engagement).set({ reconciledAt: dayAgo }).where(eq(engagement.id, engagementId));
  await db.update(moneyDiscrepancy).set({ detectedAt: dayAgo }).where(eq(moneyDiscrepancy.institutionId, w.institutionId));
  await db
    .update(sweepLease)
    .set({ heldUntil: new Date(0) })
    .where(and(eq(sweepLease.institutionId, w.institutionId), eq(sweepLease.name, "reconciliation-daily")));
}

const ids = (w: World, engagementId: string) => ({ engagementId, institutionId: w.institutionId });

after(cleanup);

test("a stamped refund the card bounced days later is flagged on its row, and the charge still agrees", async () => {
  const w = await world();
  const { actor, engagementId, paymentIntentId } = await delivered(w);
  await endPackage({ actor, engagementId });
  assert.equal(await refundThroughStripe(ids(w, engagementId)), "refunded");
  const [row] = await rows(engagementId, "refund");
  await fakeStripe.failRefund(row.stripeReference!);

  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "refund_failed", engagementId, ledgerEntryId: row.id, stripeReference: paymentIntentId, ledgerAmountMinor: 10_500, stripeAmountMinor: 0, resolutionNote: null },
  ]);
  assert.equal((await rows(engagementId, "refund"))[0].stripeReference, row.stripeReference, "the row keeps the refund it was tried against");
  await assertMoneyInvariants(w.institutionId);
});

test("a failed Dashboard refund is flagged by the webhook and the reconciliation alike, and holds the package refund until ops resolves it", async () => {
  const w = await world();
  const { actor, engagementId, checkoutSessionId, paymentIntentId } = await delivered(w);
  const dashboard = await fakeStripe.dashboardRefund(paymentIntentId, 2_000);
  await fakeStripe.failRefund(dashboard.id);

  assert.deepEqual(await deliver(await fakeStripe.refundEvent(dashboard.id, "refund.failed")), { status: 200, outcome: "refund_failed", institutionId: null });
  const flagged = { kind: "refund_failed", engagementId, ledgerEntryId: null, stripeReference: paymentIntentId, ledgerAmountMinor: 2_000, stripeAmountMinor: 0, resolutionNote: null };
  assert.deepEqual(await flags(w.institutionId), [flagged]);
  assert.deepEqual(await reconcile(w), counts(1));
  assert.deepEqual(await flags(w.institutionId), [flagged]);

  await endPackage({ actor, engagementId });
  assert.equal(await refundThroughStripe(ids(w, engagementId)), "skipped");
  assert.equal(await blockedRefunds(w.institutionId), 1);
  assert.deepEqual((await fakeStripe.refunds(checkoutSessionId)).map((r) => [r.amountMinor, r.status]), [[2_000, "failed"]]);

  await db.update(moneyDiscrepancy).set({ resolvedAt: new Date() }).where(eq(moneyDiscrepancy.institutionId, w.institutionId));
  assert.equal(await blockedRefunds(w.institutionId), 0);
  assert.equal(await refundThroughStripe(ids(w, engagementId)), "refunded");
  assert.deepEqual((await fakeStripe.refunds(checkoutSessionId)).map((r) => [r.amountMinor, r.status]), [[2_000, "failed"], [10_500, "succeeded"]]);
  await assertMoneyInvariants(w.institutionId);
});

test("a live Dashboard refund is flagged against the charge with both nets, and the tutor's transfer waits for ops", async () => {
  const w = await world();
  const { engagementId, paymentIntentId } = await delivered(w);
  await fakeStripe.dashboardRefund(paymentIntentId, 5_000);

  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "ledger_vs_stripe_charge", engagementId, ledgerEntryId: null, stripeReference: paymentIntentId, ledgerAmountMinor: 14_000, stripeAmountMinor: 9_000, resolutionNote: null },
  ]);
  assert.deepEqual(await runTransfers(w.institutionId, Date.now() + 10_000), { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 1, failed: 0 });
  assert.deepEqual(await rows(engagementId, "tutor_transfer"), []);

  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1), "the same PaymentIntent is never flagged twice");
  assert.equal((await flags(w.institutionId)).length, 1);
});

test("a reversal the webhook missed is booked and the transfers agree; a Dashboard transfer into the group is flagged", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await runTransfers(w.institutionId, Date.now() + 10_000);
  const [sent] = await rows(engagementId, "tutor_transfer");
  const [reversal] = (await fakeStripe.reverseTransfer(sent.stripeReference!, 1_000)).reversals;

  assert.deepEqual(await reconcile(w), counts(1));
  assert.deepEqual((await rows(engagementId, "transfer_reversal")).map((r) => [r.amountMinor, r.stripeReference]), [[1_000, reversal.id]]);
  assert.deepEqual(await flags(w.institutionId), []);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 1_000, transferredMinor: 2_150, currency: "usd", sessionsDelivered: 1 });

  await fakeStripe.dashboardTransfer({ engagementId, accountId: w.accountId, amountMinor: 500 });
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "ledger_vs_stripe_transfers", engagementId, ledgerEntryId: null, stripeReference: null, ledgerAmountMinor: 2_150, stripeAmountMinor: 2_650, resolutionNote: null },
  ]);
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1), "an open transfer flag on the engagement is not raised again");
  await assertMoneyInvariants(w.institutionId);
});

test("an engagement compared today is not asked about again until tomorrow", async () => {
  const w = await world();
  await delivered(w);
  assert.deepEqual(await reconcile(w), counts(1));
  await noStripe(async () => {
    assert.deepEqual(await reconcile(w), counts(0));
  });
});

test("a key that cannot see a charged payment stops the campus and flags nothing", async () => {
  const w = await world();
  const { engagementId, paymentIntentId } = await delivered(w);
  await fakeStripe.dashboardRefund(paymentIntentId, 5_000);
  fakeStripe.hide(paymentIntentId);
  try {
    await assert.rejects(reconcile(w), /STRIPE_SECRET_KEY cannot see/);
  } finally {
    fakeStripe.show(paymentIntentId);
  }
  assert.deepEqual(await flags(w.institutionId), []);
  const [row] = await db.select({ reconciledAt: engagement.reconciledAt }).from(engagement).where(eq(engagement.id, engagementId));
  assert.equal(row.reconciledAt, null);

  assert.deepEqual(await reconcile(w), counts(1, 1), "once the key is right, the next run compares it");
});

test("a row unstamped for a day is flagged without naming it, and the flag goes once the row is stamped", async () => {
  const w = await world();
  const { actor, engagementId, checkoutSessionId } = await delivered(w);
  await endPackage({ actor, engagementId });
  await db.update(ledgerEntry).set({ occurredAt: new Date(Date.now() - 25 * 3_600_000) }).where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "refund")));

  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "unstamped_reference", engagementId, ledgerEntryId: null, stripeReference: null, ledgerAmountMinor: 10_500, stripeAmountMinor: null, resolutionNote: null },
  ]);
  assert.equal(await refundThroughStripe(ids(w, engagementId)), "refunded", "the flag names no row, so the retry still runs");
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);

  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0, 0, 1));
  assert.deepEqual((await flags(w.institutionId)).map((f) => f.resolutionNote), ["Reconciliation: every row now carries its Stripe reference."]);
});

test("a released checkout's flag waits a day, then goes when Stripe holds no payment for it", async () => {
  const w = await world();
  const { buy } = await accepted(w);
  const { engagementId } = await buy();
  await db.update(engagement).set({ checkoutExpiresAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(engagement.id, engagementId));
  assert.equal(await settleCheckout(ids(w, engagementId)), "released");
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.kind, f.engagementId]), [["unstamped_reference", engagementId]]);

  assert.deepEqual(await reconcile(w), counts(0), "a Session could still be paid inside the day");
  assert.equal((await flags(w.institutionId))[0].resolutionNote, null);

  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0, 0, 1));
  assert.deepEqual((await flags(w.institutionId)).map((f) => f.resolutionNote), ["Reconciliation: Stripe holds no payment for this checkout."]);
});

test("a Session Stripe said did not exist is refunded by the daily pass once it turns up paid", async () => {
  const w = await world();
  const { engagementId, checkoutSessionId } = await checkingOut(w);
  fakeStripe.hide(checkoutSessionId);
  try {
    assert.equal(await settleCheckout(ids(w, engagementId)), "released");
    assert.deepEqual(await reconcile(w), counts(0), "still missing: left for ops");
  } finally {
    fakeStripe.show(checkoutSessionId);
  }
  await fakeStripe.pay(checkoutSessionId);

  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0, 1));
  const [refund] = await fakeStripe.refunds(checkoutSessionId);
  assert.equal(refund.amountMinor, 14_000);
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.kind, f.stripeReference, f.resolutionNote]), [
    ["ledger_vs_stripe_charge", checkoutSessionId, null],
    ["ledger_vs_stripe_charge", refund.paymentIntentId, null],
  ]);

  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0));
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1, "refunded once");
});

test("a Connect account no tutor holds is flagged once, and the scan runs once a day", async () => {
  const w = await world();
  const stray = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "stray@example.test" });

  assert.deepEqual(await reconcile(w), counts(0, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "orphaned_account", engagementId: null, ledgerEntryId: null, stripeReference: stray.id, ledgerAmountMinor: null, stripeAmountMinor: null, resolutionNote: null },
  ]);
  await patched("listAccounts", async () => { throw new Error("listed twice in a day"); }, async () => {
    assert.deepEqual(await reconcile(w), counts(0));
  });
  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0));
  assert.equal((await flags(w.institutionId)).length, 1);
});
