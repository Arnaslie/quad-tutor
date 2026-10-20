import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, moneyDiscrepancy, sweepLease, tutorProfile } from "@/server/db/schema";
import { endPackage } from "@/server/modules/engagements/termEnd";
import type { Actor } from "@/server/modules/identity/actor";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { settleCheckout } from "./checkout-session";
import { recordDiscrepancy, recordRefundFailure } from "./discrepancy";
import { assertMoneyInvariants } from "./invariants";
import { moneyForOperator, recordManualSettlement, resolveDiscrepancy } from "./ops";
import { accountsThisRun, runReconciliation } from "./reconcile";
import { blockedRefunds, refundThroughStripe } from "./refunds";
import { GatewayError, fakeStripe, stripeGateway } from "./stripe";
import { accepted, anotherSessionDelivered, checkingOut, cleanup, deliver, delivered, newestRefund, noStripe, operator, patched, person, rows, world, type World } from "./test-world";
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

async function sendsAfterAnotherSession(w: World, actor: Actor, engagementId: string) {
  await anotherSessionDelivered(w, actor, engagementId);
  return (await runTransfers(w.institutionId, Date.now() + 10_000)).sent;
}

after(cleanup);

test("a stamped refund the card bounced days later is flagged on its row, and the charge still agrees", async () => {
  const w = await world();
  const { actor, engagementId } = await delivered(w);
  await endPackage({ actor, engagementId });
  assert.equal(await refundThroughStripe(await newestRefund(engagementId)), "refunded");
  const [row] = await rows(engagementId, "refund");
  await fakeStripe.failRefund(row.stripeReference!);

  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "refund_failed", engagementId, ledgerEntryId: row.id, stripeReference: row.id, ledgerAmountMinor: 9_450, stripeAmountMinor: 0, resolutionNote: null },
  ]);
  assert.equal((await rows(engagementId, "refund"))[0].stripeReference, row.stripeReference, "the row keeps the refund it was tried against");
  await assertMoneyInvariants(w.institutionId);
});

test("a failed Dashboard refund is flagged by the webhook and the reconciliation alike, and holds the package refund until ops resolves it", async () => {
  const w = await world();
  const { actor, engagementId, checkoutSessionId, paymentIntentId } = await delivered(w);
  const dashboard = await fakeStripe.dashboardRefund(paymentIntentId, 2_000);
  await fakeStripe.failRefund(dashboard.id);

  assert.deepEqual(await deliver(await fakeStripe.refundEvent(dashboard.id, "refund.failed")), { status: 200, outcome: "refund_failed", institutionId: w.institutionId });
  const flagged = { kind: "refund_failed", engagementId, ledgerEntryId: null, stripeReference: paymentIntentId, ledgerAmountMinor: 2_000, stripeAmountMinor: 0, resolutionNote: null };
  assert.deepEqual(await flags(w.institutionId), [flagged]);
  assert.deepEqual(await reconcile(w), counts(1));
  assert.deepEqual(await flags(w.institutionId), [flagged]);

  await endPackage({ actor, engagementId });
  assert.equal(await refundThroughStripe(await newestRefund(engagementId)), "skipped");
  assert.equal(await blockedRefunds(w.institutionId), 1);
  assert.deepEqual((await fakeStripe.refunds(checkoutSessionId)).map((r) => [r.amountMinor, r.status]), [[2_000, "failed"]]);

  await db.update(moneyDiscrepancy).set({ resolvedAt: new Date() }).where(eq(moneyDiscrepancy.institutionId, w.institutionId));
  assert.equal(await blockedRefunds(w.institutionId), 0);
  assert.equal(await refundThroughStripe(await newestRefund(engagementId)), "refunded");
  assert.deepEqual((await fakeStripe.refunds(checkoutSessionId)).map((r) => [r.amountMinor, r.status]), [[2_000, "failed"], [9_450, "succeeded"]]);
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

test("a charge flag ops resolved reopens when the PaymentIntent diverges again, and stays resolved when it has not", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { engagementId, paymentIntentId } = await delivered(w);
  await fakeStripe.dashboardRefund(paymentIntentId, 5_000);
  assert.deepEqual(await reconcile(w), counts(1, 1));
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "support refunded part" }), { ok: true });

  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1), "the same divergence stays resolved");
  assert.deepEqual((await flags(w.institutionId)).map((f) => f.resolutionNote), ["support refunded part"]);

  await fakeStripe.dashboardRefund(paymentIntentId, 2_000);
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "ledger_vs_stripe_charge", engagementId, ledgerEntryId: null, stripeReference: paymentIntentId, ledgerAmountMinor: 14_000, stripeAmountMinor: 7_000, resolutionNote: null },
  ]);
  const [reopened] = await db.select({ resolvedAt: moneyDiscrepancy.resolvedAt, by: moneyDiscrepancy.resolvedByUserId }).from(moneyDiscrepancy).where(eq(moneyDiscrepancy.id, item.id));
  assert.deepEqual(reopened, { resolvedAt: null, by: null });
  assert.deepEqual(await runTransfers(w.institutionId, Date.now() + 10_000), { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 1, failed: 0 });
});

/** Support refunded `amountMinor` in the Dashboard before the package's own refund of 9_450 went out. */
async function refundedInDashboard(w: World, amountMinor: number) {
  const bought = await delivered(w);
  const dashboard = await fakeStripe.dashboardRefund(bought.paymentIntentId, amountMinor);
  await endPackage({ actor: bought.actor, engagementId: bought.engagementId });
  assert.equal(await refundThroughStripe(await newestRefund(bought.engagementId)), "flagged");
  return { ...bought, dashboard };
}

const nets = async (w: World, engagementId: string, paymentIntentId: string) => {
  const payment = await stripeGateway().retrievePayment(paymentIntentId);
  const [refund] = await rows(engagementId, "refund");
  return { ledger: 14_000 - refund.amountMinor, stripe: payment.amountMinor - payment.refundedMinor };
};

test("settling a Dashboard refund of the row's amount stamps the row with it, and the reconciliation then agrees", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { engagementId, paymentIntentId, dashboard } = await refundedInDashboard(w, 9_450);
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(
    [item.kind, item.stripeReference, item.ledgerAmountMinor, item.stripeAmountMinor, item.row?.type, item.canSettle, item.canResolve],
    ["ledger_vs_stripe_charge", dashboard.id, 9_450, 9_450, "refund", true, false],
  );

  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: item.id, note: "support refunded in the Dashboard" }), { ok: true });
  assert.deepEqual((await rows(engagementId, "refund")).map((r) => [r.amountMinor, r.stripeReference]), [[9_450, dashboard.id]]);

  assert.deepEqual(await reconcile(w), counts(1));
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.kind, f.stripeReference, f.resolutionNote]), [
    ["ledger_vs_stripe_charge", dashboard.id, "support refunded in the Dashboard"],
  ]);
  assert.deepEqual(await nets(w, engagementId, paymentIntentId), { ledger: 4_550, stripe: 4_550 });
  assert.equal((await runTransfers(w.institutionId, Date.now() + 10_000)).sent, 1);
  await assertMoneyInvariants(w.institutionId);
});

test("settling a smaller Dashboard refund books it on the row and leaves the rest owed on the charge until ops refunds it", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { engagementId, paymentIntentId, dashboard } = await refundedInDashboard(w, 5_000);
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: item.id, note: "support refunded part" }), { ok: true });
  assert.deepEqual((await rows(engagementId, "refund")).map((r) => [r.amountMinor, r.stripeReference]), [[9_450, dashboard.id]]);

  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.kind, f.stripeReference, f.ledgerAmountMinor, f.stripeAmountMinor, f.resolutionNote]), [
    ["ledger_vs_stripe_charge", dashboard.id, 9_450, 5_000, "support refunded part"],
    ["ledger_vs_stripe_charge", paymentIntentId, 4_550, 9_000, null],
  ]);
  await assertMoneyInvariants(w.institutionId);

  await fakeStripe.dashboardRefund(paymentIntentId, 4_450);
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1));
  assert.deepEqual(await nets(w, engagementId, paymentIntentId), { ledger: 4_550, stripe: 4_550 });
  const [rest] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: rest.id, note: "refunded the rest in the Dashboard" }), { ok: true });
  assert.equal((await runTransfers(w.institutionId, Date.now() + 10_000)).sent, 1);
  await assertMoneyInvariants(w.institutionId);
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
    { kind: "ledger_vs_stripe_transfers", engagementId, ledgerEntryId: null, stripeReference: engagementId, ledgerAmountMinor: 2_150, stripeAmountMinor: 2_650, resolutionNote: null },
  ]);
  assert.deepEqual(
    (await moneyForOperator(await operator(w.institutionId))).discrepancies.map((d) => [d.kind, d.stripeReference]),
    [["ledger_vs_stripe_transfers", null]],
    "the engagement id it is keyed on is not a Stripe id",
  );
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1), "an open transfer flag on the engagement is not raised again");
  await assertMoneyInvariants(w.institutionId);
});

test("a transfer gap ops resolved stays resolved while it holds, and the same flag reopens when it moves", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { engagementId } = await delivered(w);
  assert.equal((await runTransfers(w.institutionId, Date.now() + 10_000)).sent, 1);
  await fakeStripe.dashboardTransfer({ engagementId, accountId: w.accountId, amountMinor: 500 });
  assert.deepEqual(await reconcile(w), counts(1, 1));
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "bonus paid in the Dashboard" }), { ok: true });

  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1), "the same gap stays resolved");
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "ledger_vs_stripe_transfers", engagementId, ledgerEntryId: null, stripeReference: engagementId, ledgerAmountMinor: 3_150, stripeAmountMinor: 3_650, resolutionNote: "bonus paid in the Dashboard" },
  ]);

  await fakeStripe.dashboardTransfer({ engagementId, accountId: w.accountId, amountMinor: 200 });
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "ledger_vs_stripe_transfers", engagementId, ledgerEntryId: null, stripeReference: engagementId, ledgerAmountMinor: 3_150, stripeAmountMinor: 3_850, resolutionNote: null },
  ]);
  const [reopened] = await db.select({ id: moneyDiscrepancy.id, resolvedAt: moneyDiscrepancy.resolvedAt }).from(moneyDiscrepancy).where(eq(moneyDiscrepancy.institutionId, w.institutionId));
  assert.deepEqual(reopened, { id: item.id, resolvedAt: null });
});

test("a transfer gap ops resolved stays resolved when a later transfer moves both sides, and reopens when the gap itself moves", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { actor, engagementId } = await delivered(w);
  assert.equal((await runTransfers(w.institutionId, Date.now() + 10_000)).sent, 1);
  await fakeStripe.dashboardTransfer({ engagementId, accountId: w.accountId, amountMinor: 500 });
  assert.deepEqual(await reconcile(w), counts(1, 1));
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "goodwill bonus" }), { ok: true });

  assert.equal(await sendsAfterAnotherSession(w, actor, engagementId), 1);
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1), "6,300 against 6,800 is the same 500 ops answered");
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.ledgerAmountMinor, f.stripeAmountMinor, f.resolutionNote]), [[3_150, 3_650, "goodwill bonus"]]);
  assert.equal(await sendsAfterAnotherSession(w, actor, engagementId), 1, "the tutor's pay is not paused");

  await fakeStripe.dashboardTransfer({ engagementId, accountId: w.accountId, amountMinor: 200 });
  await aDayLater(w, engagementId);
  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.ledgerAmountMinor, f.stripeAmountMinor, f.resolutionNote]), [[9_450, 10_150, null]]);
  assert.equal(await sendsAfterAnotherSession(w, actor, engagementId), 0, "a moved gap pauses the tutor's pay again");
});

test("a refund and a transfer stamped between the Stripe reads and the ledger read are not flagged", async () => {
  const w = await world();
  const { actor, engagementId } = await delivered(w);
  const real = stripeGateway().listTransfers;
  let raced = false;
  await patched("listTransfers", async (group) => {
    const listed = await real(group);
    if (!raced) {
      raced = true;
      assert.equal((await runTransfers(w.institutionId, Date.now() + 10_000)).sent, 1);
      await endPackage({ actor, engagementId });
      assert.equal(await refundThroughStripe(await newestRefund(engagementId)), "refunded");
    }
    return listed;
  }, async () => {
    assert.deepEqual(await reconcile(w), counts(1));
  });
  assert.deepEqual(await flags(w.institutionId), []);
  assert.deepEqual([(await rows(engagementId, "refund"))[0].amountMinor, (await rows(engagementId, "tutor_transfer"))[0].amountMinor], [9_450, 3_150]);
  await assertMoneyInvariants(w.institutionId);
});

test("a transfer reversed more than ten times has every reversal booked, and the transfers agree", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await runTransfers(w.institutionId, Date.now() + 10_000);
  const [sent] = await rows(engagementId, "tutor_transfer");
  for (let i = 0; i < 11; i += 1) await fakeStripe.reverseTransfer(sent.stripeReference!, 100);

  assert.deepEqual(await reconcile(w), counts(1));
  const booked = await rows(engagementId, "transfer_reversal");
  assert.deepEqual([booked.length, booked.reduce((sum, r) => sum + r.amountMinor, 0)], [11, 1_100]);
  assert.deepEqual(await flags(w.institutionId), []);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 1_100, transferredMinor: 2_050, currency: "usd", sessionsDelivered: 1 });
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

test("a daily pass the key stopped runs again on the next cron run", async () => {
  const w = await world();
  const { paymentIntentId } = await delivered(w);
  assert.deepEqual(await reconcile(w), counts(1));
  await aDayLater(w);
  const stray = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "stray@example.test" });
  fakeStripe.hide(paymentIntentId);
  try {
    await assert.rejects(reconcile(w), /STRIPE_SECRET_KEY cannot see/);
  } finally {
    fakeStripe.show(paymentIntentId);
  }
  assert.deepEqual(await flags(w.institutionId), []);

  assert.deepEqual(await reconcile(w), counts(0, 1));
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.kind, f.stripeReference]), [["orphaned_account", stray.id]]);
});

test("a daily pass the deadline cut short runs again on the next cron run", async (t) => {
  const w = await world();
  const sessions = [(await checkingOut(w)).checkoutSessionId, (await checkingOut(w)).checkoutSessionId];
  for (const id of sessions) fakeStripe.hide(id);
  try {
    for (const id of sessions) {
      const [row] = await db.select({ id: engagement.id }).from(engagement).where(eq(engagement.stripeCheckoutSessionId, id));
      assert.equal(await settleCheckout(ids(w, row.id)), "released");
    }
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const asked: string[] = [];
    const real = stripeGateway().retrieveCheckout;
    await patched("retrieveCheckout", async (id) => {
      if (sessions.includes(id)) {
        asked.push(id);
        t.mock.timers.tick(400);
      }
      return real(id);
    }, async () => {
      assert.deepEqual(await runReconciliation(w.institutionId, Date.now() + 300), counts(0));
      assert.equal(asked.length, 1, "the deadline stopped the pass after the first Session");
      assert.deepEqual(await reconcile(w), counts(0));
      assert.deepEqual(asked.slice(1).toSorted(), sessions.toSorted(), "the next run asked about both again");
    });
  } finally {
    for (const id of sessions) fakeStripe.show(id);
  }
});

test("a row unstamped for a day is flagged without naming it, and the flag goes once the row is stamped", async () => {
  const w = await world();
  const { actor, engagementId, checkoutSessionId } = await delivered(w);
  await endPackage({ actor, engagementId });
  await db.update(ledgerEntry).set({ occurredAt: new Date(Date.now() - 25 * 3_600_000) }).where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "refund")));

  assert.deepEqual(await reconcile(w), counts(1, 1));
  assert.deepEqual(await flags(w.institutionId), [
    { kind: "unstamped_reference", engagementId, ledgerEntryId: null, stripeReference: null, ledgerAmountMinor: 9_450, stripeAmountMinor: null, resolutionNote: null },
  ]);
  assert.equal(await refundThroughStripe(await newestRefund(engagementId)), "refunded", "the flag names no row, so the retry still runs");
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

  const late = await person(w.institutionId);
  await db.insert(tutorProfile).values({ userId: late.userId, institutionId: w.institutionId, stripeAccountId: stray.id });
  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0, 0, 1));
  const [resolved] = await db.select({ note: moneyDiscrepancy.resolutionNote, by: moneyDiscrepancy.resolvedByUserId }).from(moneyDiscrepancy).where(eq(moneyDiscrepancy.institutionId, w.institutionId));
  assert.deepEqual(resolved, { note: "Reconciliation: a tutor on this campus now holds this account.", by: null });
});

test("the daily pass puts every held account on its tutor's stored speed, and leaves the rest alone", async () => {
  const w = await world();
  await fakeStripe.setPayoutSchedule(w.accountId, "daily");
  const chose = await person(w.institutionId);
  const daily = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "daily@example.test" });
  await db.insert(tutorProfile).values({ userId: chose.userId, institutionId: w.institutionId, stripeAccountId: daily.id, payoutSpeed: "daily" });
  await fakeStripe.setPayoutSchedule(daily.id, "daily");
  const stray = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "stray@example.test" });
  await fakeStripe.setPayoutSchedule(stray.id, null);
  const elsewhere = await world();
  await fakeStripe.setPayoutSchedule(elsewhere.accountId, "daily");

  const calls: [string, string][] = [];
  const real = stripeGateway().setPayoutSpeed;
  await patched("setPayoutSpeed", (accountId, speed) => {
    calls.push([accountId, speed]);
    return real(accountId, speed);
  }, async () => {
    assert.deepEqual(await reconcile(w), counts(0, 1));
    await aDayLater(w);
    assert.deepEqual(await reconcile(w), counts(0));
  });
  assert.deepEqual(calls, [[w.accountId, "weekly"]]);
  const speeds = await Promise.all(
    [w.accountId, daily.id, stray.id, elsewhere.accountId].map(async (id) => (await stripeGateway().retrieveAccount(id)).payoutSpeed),
  );
  assert.deepEqual(speeds, ["weekly", "daily", null, "daily"]);
});

test("the deadline stops the speed sync between accounts, and the next cron run moves the rest", async (t) => {
  const w = await world();
  const late = await person(w.institutionId);
  const other = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "other@example.test" });
  await db.insert(tutorProfile).values({ userId: late.userId, institutionId: w.institutionId, stripeAccountId: other.id });
  const legacy = [w.accountId, other.id];
  for (const id of legacy) await fakeStripe.setPayoutSchedule(id, "daily");

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const calls: string[] = [];
  const real = stripeGateway().setPayoutSpeed;
  await patched("setPayoutSpeed", (accountId, speed) => {
    calls.push(accountId);
    t.mock.timers.tick(400);
    return real(accountId, speed);
  }, async () => {
    await runReconciliation(w.institutionId, Date.now() + 300);
    assert.equal(calls.length, 1, "the deadline stopped the sync after the first account");
    await reconcile(w);
  });
  assert.deepEqual(calls.toSorted(), legacy.toSorted());
  for (const id of legacy) assert.equal((await stripeGateway().retrieveAccount(id)).payoutSpeed, "weekly");
});

test("an orphaned account's flag that resolved itself reopens once no tutor holds the account again, and one ops resolved stays resolved", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const stray = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "stray@example.test" });
  assert.deepEqual(await reconcile(w), counts(0, 1));
  const [{ id }] = (await moneyForOperator(ops)).orphanedAccounts;

  const late = await person(w.institutionId);
  await db.insert(tutorProfile).values({ userId: late.userId, institutionId: w.institutionId, stripeAccountId: stray.id });
  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0, 0, 1));

  await db.update(tutorProfile).set({ stripeAccountId: null }).where(eq(tutorProfile.userId, late.userId));
  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0, 1));
  assert.deepEqual((await moneyForOperator(ops)).orphanedAccounts.map((a) => [a.id, a.accountId]), [[id, stray.id]], "the same flag, open again");

  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: id, note: "test account, deleting at Stripe" }), { ok: true });
  await aDayLater(w);
  assert.deepEqual(await reconcile(w), counts(0));
  assert.deepEqual((await flags(w.institutionId)).map((f) => [f.stripeReference, f.resolutionNote]), [[stray.id, "test account, deleting at Stripe"]]);
});

test("one cron run lists Connect accounts once for every campus", async () => {
  const campuses = [await world(), await world()];
  const strays = await Promise.all(
    campuses.map((w) => stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "stray@example.test" })),
  );
  let listed = 0;
  const real = stripeGateway().listAccounts;
  await patched("listAccounts", async () => {
    listed += 1;
    return real();
  }, async () => {
    const accounts = accountsThisRun();
    for (const w of campuses) assert.deepEqual(await runReconciliation(w.institutionId, Date.now() + 10_000, accounts), counts(0, 1));
  });
  assert.equal(listed, 1);
  assert.deepEqual(
    await Promise.all(campuses.map(async (w) => (await flags(w.institutionId)).map((f) => f.stripeReference))),
    strays.map((stray) => [stray.id]),
  );
});

test("a Connect account listing that failed is asked for again by the next campus in the run", async () => {
  const campuses = [await world(), await world()];
  const stray = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: campuses[1].institutionId, email: "stray@example.test" });
  let listed = 0;
  const real = stripeGateway().listAccounts;
  await patched("listAccounts", async () => {
    listed += 1;
    if (listed === 1) throw new GatewayError("Stripe is down.", { status: 503 });
    return real();
  }, async () => {
    const accounts = accountsThisRun();
    assert.deepEqual(await runReconciliation(campuses[0].institutionId, Date.now() + 10_000, accounts), { checked: 0, flagged: 0, resolved: 0, failed: 1 });
    assert.deepEqual(await runReconciliation(campuses[1].institutionId, Date.now() + 10_000, accounts), counts(0, 1));
  });
  assert.equal(listed, 2);
  assert.deepEqual((await flags(campuses[1].institutionId)).map((f) => [f.kind, f.stripeReference]), [["orphaned_account", stray.id]]);
});

test("a flag on another campus's key is never touched", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const other = await world();
  const { engagementId, paymentIntentId } = await delivered(w);
  await fakeStripe.dashboardRefund(paymentIntentId, 5_000);
  assert.deepEqual(await reconcile(w), counts(1, 1));
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "support refunded part" }), { ok: true });
  const theirs = await delivered(other);

  assert.equal(
    await recordDiscrepancy(ids(other, theirs.engagementId), { kind: "ledger_vs_stripe_charge", stripeReference: paymentIntentId, ledgerAmountMinor: 1, stripeAmountMinor: 0 }),
    null,
  );
  const [ourRow] = await rows(engagementId, "package_purchase");
  await recordRefundFailure(ids(w, engagementId), { refund: null, paymentIntentId, amountMinor: 2_000, currency: "usd" });
  await recordRefundFailure(ids(w, engagementId), { refund: null, paymentIntentId, amountMinor: 3_000, currency: "usd", ledgerEntryId: ourRow.id });
  await recordRefundFailure(ids(other, theirs.engagementId), { refund: null, paymentIntentId, amountMinor: 1, currency: "usd" });
  await recordRefundFailure(ids(other, theirs.engagementId), { refund: null, paymentIntentId, amountMinor: 1, currency: "usd", ledgerEntryId: ourRow.id });

  assert.deepEqual(await flags(w.institutionId), [
    { kind: "ledger_vs_stripe_charge", engagementId, ledgerEntryId: null, stripeReference: paymentIntentId, ledgerAmountMinor: 14_000, stripeAmountMinor: 9_000, resolutionNote: "support refunded part" },
    { kind: "refund_failed", engagementId, ledgerEntryId: null, stripeReference: paymentIntentId, ledgerAmountMinor: 2_000, stripeAmountMinor: 0, resolutionNote: null },
    { kind: "refund_failed", engagementId, ledgerEntryId: ourRow.id, stripeReference: ourRow.id, ledgerAmountMinor: 3_000, stripeAmountMinor: 0, resolutionNote: null },
  ]);
  assert.deepEqual(await flags(other.institutionId), []);
});
