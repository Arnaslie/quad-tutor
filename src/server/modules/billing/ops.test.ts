import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { ledgerEntry, moneyDiscrepancy, paymentDispute, sessionBooking } from "@/server/db/schema";
import { confirmAttendance } from "@/server/modules/engagements/confirmation";
import { bookSession, slotsForEngagement } from "@/server/modules/engagements/scheduling";
import { endPackage } from "@/server/modules/engagements/termEnd";
import type { Actor } from "@/server/modules/identity/actor";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { assertMoneyInvariants } from "./invariants";
import { answerReversal, liftDisputePause, moneyForOperator, recordManualSettlement, resolveDiscrepancy } from "./ops";
import { runReconciliation } from "./reconcile";
import { refundThroughStripe } from "./refunds";
import { GatewayError, fakeStripe, stripeGateway } from "./stripe";
import { cleanup, deliver, delivered, operator, patched, rows, world, type World } from "./test-world";
import { runTransfers, sendTransferRow } from "./transfers";

const nothing = { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 0, failed: 0 };
const sweep = (w: World) => runTransfers(w.institutionId, Date.now() + 10_000);
const gone = { ok: false, refusal: "gone" };

/** Dates are when the test ran; the rest of each item is literal. */
const undated = (items: object[]) =>
  items.map((item) => Object.fromEntries(Object.entries(item).map(([key, value]) => [key, value instanceof Date ? "date" : value])));

async function creates(work: () => Promise<void>): Promise<number[]> {
  const amounts: number[] = [];
  const real = stripeGateway().createTransfer;
  await patched("createTransfer", async (params) => {
    amounts.push(params.amountMinor);
    return real(params);
  }, work);
  return amounts;
}

/** Sent, then reversed in part at Stripe, and the reversal booked from its webhook. */
async function reversed(w: World, amountMinor: number) {
  const bought = await delivered(w);
  assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
  const [sent] = await rows(bought.engagementId, "tutor_transfer");
  await fakeStripe.reverseTransfer(sent.stripeReference!, amountMinor);
  await deliver(await fakeStripe.transferEvent(sent.stripeReference!, "transfer.reversed"));
  const [reversal] = await rows(bought.engagementId, "transfer_reversal");
  return { ...bought, sent, reversal };
}

async function answers(engagementId: string, reversalId: string) {
  return (await rows(engagementId, "tutor_transfer")).filter((r) => r.correctsEntryId === reversalId).map((r) => [r.amountMinor, r.stripeReference]);
}

async function refusedTransfer(w: World) {
  const bought = await delivered(w);
  await patched("createTransfer", async () => { throw new GatewayError("Insufficient funds.", { status: 400, code: "balance_insufficient" }); }, async () => {
    assert.equal((await sweep(w)).flagged, 1);
  });
  return bought;
}

async function disputed(paymentIntentId: string) {
  const dispute = await fakeStripe.dispute(paymentIntentId);
  await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.created"));
  const [row] = await db.select({ id: paymentDispute.id }).from(paymentDispute).where(eq(paymentDispute.stripeDisputeId, dispute.id));
  return { stripeId: dispute.id, id: row.id };
}

async function anotherSessionDelivered(w: World, actor: Actor, engagementId: string) {
  const [slot] = await slotsForEngagement({ actor, engagementId });
  const { sessionId } = await bookSession({ actor, engagementId, slotStartsAt: slot });
  await db.update(sessionBooking).set({ scheduledAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(sessionBooking.id, sessionId));
  await confirmAttendance({ actor, sessionId });
  assert.equal((await confirmAttendance({ actor: w.tutor, sessionId })).status, "completed");
}

async function flag(id: string) {
  const [row] = await db
    .select({ resolved: moneyDiscrepancy.resolvedAt, note: moneyDiscrepancy.resolutionNote, by: moneyDiscrepancy.resolvedByUserId })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.id, id));
  return { ...row, resolved: row.resolved !== null };
}

after(cleanup);

test("a reversal ops re-sends goes out as its own transfer, and a later accrual is sent once at its own amount", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { actor, engagementId, sent, reversal } = await reversed(w, 1_000);
  assert.deepEqual(undated((await moneyForOperator(ops)).reversals), [
    {
      id: reversal.id,
      amountMinor: 1_000,
      currency: "usd",
      reference: reversal.stripeReference,
      bookedAt: "date",
      paused: false,
      engagement: { courseLabel: w.courseCode, tutorName: w.tutor.name, studentName: actor.name },
    },
  ]);

  const answered = await answerReversal({ operator: ops, reversalId: reversal.id, answer: "resend" });
  assert.equal(answered.ok, true);
  const resend = answered.ok ? answered.resend! : null!;
  assert.deepEqual({ ...resend, id: null }, { engagementId, institutionId: w.institutionId, id: null });
  assert.deepEqual(await creates(async () => {
    assert.equal(await sendTransferRow(resend), "transferred");
  }), [1_000]);
  const again = (await rows(engagementId, "tutor_transfer")).find((r) => r.correctsEntryId === reversal.id)!;
  assert.equal(again.id, resend.id);
  assert.match(again.stripeReference!, /^tr_fake_/);
  assert.notEqual(again.stripeReference, sent.stripeReference);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });
  assert.deepEqual((await moneyForOperator(ops)).reversals, []);

  await anotherSessionDelivered(w, actor, engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
    assert.deepEqual(await sweep(w), nothing);
  }), [3_150]);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.amountMinor).sort(), [1_000, 3_150, 3_150]);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 6_300, owedMinor: 0, transferredMinor: 6_300, currency: "usd", sessionsDelivered: 2 });
  await assertMoneyInvariants(w.institutionId);
});

test("a forfeited reversal is neither owed nor transferred, and one paid by hand counts as transferred", async () => {
  const forfeiting = await world();
  const { engagementId, reversal } = await reversed(forfeiting, 1_000);
  assert.deepEqual(await answerReversal({ operator: await operator(forfeiting.institutionId), reversalId: reversal.id, answer: "forfeited" }), { ok: true, resend: null });
  assert.deepEqual(await answers(engagementId, reversal.id), [[1_000, `forfeited:${reversal.id}`]]);
  assert.deepEqual(await earningsForTutor(forfeiting.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 2_150, currency: "usd", sessionsDelivered: 1 });
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(forfeiting), nothing);
  }), []);
  await assertMoneyInvariants(forfeiting.institutionId);

  const byHand = await world();
  const paid = await reversed(byHand, 1_000);
  assert.deepEqual(await answerReversal({ operator: await operator(byHand.institutionId), reversalId: paid.reversal.id, answer: "manual" }), { ok: true, resend: null });
  assert.deepEqual(await answers(paid.engagementId, paid.reversal.id), [[1_000, `manual:${paid.reversal.id}`]]);
  assert.deepEqual(await earningsForTutor(byHand.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });
  await assertMoneyInvariants(byHand.institutionId);
});

test("rows lists an engagement's ledger rows oldest first, whatever order they were written in", async () => {
  const w = await world();
  const { engagementId, sent, reversal } = await reversed(w, 1_000);
  await answerReversal({ operator: await operator(w.institutionId), reversalId: reversal.id, answer: "forfeited" });
  const [answer] = (await rows(engagementId, "tutor_transfer")).filter((r) => r.correctsEntryId === reversal.id);
  await db.update(ledgerEntry).set({ occurredAt: new Date(Date.now() - 86_400_000) }).where(eq(ledgerEntry.id, answer.id));
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.stripeReference), [`forfeited:${reversal.id}`, sent.stripeReference]);
});

test("a reversal is answered once, and a re-send waits while a dispute holds the engagement", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { engagementId, paymentIntentId, reversal } = await reversed(w, 3_150);
  await disputed(paymentIntentId);
  assert.equal((await moneyForOperator(ops)).reversals[0].paused, true);

  assert.deepEqual(await answerReversal({ operator: ops, reversalId: reversal.id, answer: "resend" }), { ok: false, refusal: "paused" });
  assert.equal((await rows(engagementId, "tutor_transfer")).length, 1, "a refused re-send writes nothing");

  const raced = await Promise.all([
    answerReversal({ operator: ops, reversalId: reversal.id, answer: "manual" }),
    answerReversal({ operator: ops, reversalId: reversal.id, answer: "forfeited" }),
  ]);
  assert.deepEqual(raced.map((r) => r.ok).sort(), [false, true]);
  assert.deepEqual(raced.find((r) => !r.ok), { ok: false, refusal: "answered" });
  assert.deepEqual(await answerReversal({ operator: ops, reversalId: reversal.id, answer: "resend" }), { ok: false, refusal: "answered" });
  assert.equal((await rows(engagementId, "tutor_transfer")).length, 2);
  await assertMoneyInvariants(w.institutionId);
});

test("ops lifts a dispute's pause only once Stripe has closed it, and the tutor is then paid", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { actor, paymentIntentId } = await delivered(w);
  const dispute = await disputed(paymentIntentId);
  const engagement = { courseLabel: w.courseCode, tutorName: w.tutor.name, studentName: actor.name };
  const item = { id: dispute.id, amountMinor: 14_000, currency: "usd", reason: "fraudulent", openedAt: "date", engagement };
  assert.deepEqual(undated((await moneyForOperator(ops)).disputes), [{ ...item, status: "needs_response", closedAt: null, canLift: false }]);

  assert.deepEqual(await liftDisputePause({ operator: ops, disputeId: dispute.id, note: "waiting on Stripe" }), { ok: false, refusal: "open_at_stripe" });
  assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 });

  await fakeStripe.closeDispute(dispute.stripeId, "won");
  await deliver(await fakeStripe.disputeEvent(dispute.stripeId, "charge.dispute.closed"));
  assert.deepEqual(undated((await moneyForOperator(ops)).disputes), [{ ...item, status: "won", closedAt: "date", canLift: true }]);
  assert.deepEqual(await liftDisputePause({ operator: ops, disputeId: dispute.id, note: "won; nothing owed back" }), { ok: true });
  assert.deepEqual(await liftDisputePause({ operator: ops, disputeId: dispute.id, note: "again" }), gone);
  const [lifted] = await db
    .select({ note: paymentDispute.resolutionNote, by: paymentDispute.resolvedByUserId, resolved: paymentDispute.resolvedAt })
    .from(paymentDispute)
    .where(eq(paymentDispute.id, dispute.id));
  assert.deepEqual({ ...lifted, resolved: lifted.resolved !== null }, { note: "won; nothing owed back", by: ops.userId, resolved: true });
  assert.deepEqual((await moneyForOperator(ops)).disputes, []);

  assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
  await assertMoneyInvariants(w.institutionId);
});

test("settling a refused transfer by hand stamps its row manual:<discrepancy> and no sweep sends it", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { actor, engagementId } = await refusedTransfer(w);
  const [row] = await rows(engagementId, "tutor_transfer");
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual(undated([item]), [
    {
      id: item.id,
      kind: "ledger_vs_stripe_transfers",
      stripeReference: null,
      ledgerAmountMinor: 3_150,
      stripeAmountMinor: null,
      currency: "usd",
      detectedAt: "date",
      ledgerEntryType: "tutor_transfer",
      engagement: { courseLabel: w.courseCode, tutorName: w.tutor.name, studentName: actor.name },
      canSettle: true,
      canResolve: false,
    },
  ]);

  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "paid by Zelle" }), { ok: false, refusal: "settle_instead" });
  assert.deepEqual(await flag(item.id), { resolved: false, note: null, by: null }, "resolving would strand the row unsent and unsettled");
  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: item.id, note: "paid by Zelle, ticket 31" }), { ok: true });
  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: item.id, note: "again" }), gone);
  assert.deepEqual(await rows(engagementId, "tutor_transfer"), [{ ...row, stripeReference: `manual:${item.id}` }]);
  assert.deepEqual(await flag(item.id), { resolved: true, note: "paid by Zelle, ticket 31", by: ops.userId });
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), nothing);
  }), []);
  await assertMoneyInvariants(w.institutionId);
});

test("resolving a discrepancy records when, why and who, and a flag naming no row cannot be settled by hand", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const { paymentIntentId } = await delivered(w);
  await fakeStripe.dashboardRefund(paymentIntentId, 5_000);
  assert.equal((await runReconciliation(w.institutionId, Date.now() + 10_000)).flagged, 1);
  const [item] = (await moneyForOperator(ops)).discrepancies;
  assert.deepEqual([item.kind, item.canSettle, item.canResolve, item.ledgerEntryType], ["ledger_vs_stripe_charge", false, true, null]);

  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: item.id, note: "nothing to stamp" }), { ok: false, refusal: "not_settleable" });
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "refunded by support in the Dashboard" }), { ok: true });
  assert.deepEqual(await resolveDiscrepancy({ operator: ops, discrepancyId: item.id, note: "again" }), gone);
  assert.deepEqual(await flag(item.id), { resolved: true, note: "refunded by support in the Dashboard", by: ops.userId });
  assert.deepEqual((await moneyForOperator(ops)).discrepancies, []);
});

test("a dispute or reversal whose engagement cannot be shown is still listed, with no context", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const elsewhere = await world();
  const { paymentIntentId, reversal } = await reversed(elsewhere, 1_000);
  const dispute = await disputed(paymentIntentId);
  await db.update(paymentDispute).set({ institutionId: w.institutionId }).where(eq(paymentDispute.id, dispute.id));
  await db.update(ledgerEntry).set({ institutionId: w.institutionId }).where(eq(ledgerEntry.id, reversal.id));

  const money = await moneyForOperator(ops);
  assert.deepEqual(money.disputes.map((d) => [d.id, d.amountMinor, d.engagement]), [[dispute.id, 14_000, null]]);
  assert.deepEqual(money.reversals.map((r) => [r.id, r.amountMinor, r.engagement]), [[reversal.id, 1_000, null]]);
});

test("an operator sees their own campus's money items and held counts, and nothing of another campus's", async () => {
  const w = await world();
  const ops = await operator(w.institutionId);
  const sentBack = await reversed(w, 1_000);
  const refused = await refusedTransfer(w);
  const held = await delivered(w);
  const dispute = await disputed(held.paymentIntentId);
  const bounced = await delivered(w);
  const dashboard = await fakeStripe.dashboardRefund(bounced.paymentIntentId, 2_000);
  await fakeStripe.failRefund(dashboard.id);
  await deliver(await fakeStripe.refundEvent(dashboard.id, "refund.failed"));
  await endPackage({ actor: bounced.actor, engagementId: bounced.engagementId });
  assert.equal(await refundThroughStripe({ engagementId: bounced.engagementId, institutionId: w.institutionId }), "skipped");
  const stray = await stripeGateway().createAccount({ tutorProfileId: randomUUID(), institutionId: w.institutionId, email: "stray@example.test" });
  assert.equal((await runReconciliation(w.institutionId, Date.now() + 10_000)).flagged, 1);

  const money = await moneyForOperator(ops);
  assert.deepEqual(
    money.discrepancies.map((d) => [d.kind, d.engagement?.studentName, d.ledgerEntryType, d.canSettle]),
    [
      ["refund_failed", bounced.actor.name, null, true],
      ["ledger_vs_stripe_transfers", refused.actor.name, "tutor_transfer", true],
    ],
  );
  assert.deepEqual(undated(money.orphanedAccounts).map(({ id, ...rest }) => [typeof id, rest]), [["string", { accountId: stray.id, detectedAt: "date" }]]);
  assert.deepEqual(money.disputes.map((d) => [d.id, d.engagement?.studentName, d.canLift]), [[dispute.id, held.actor.name, false]]);
  assert.deepEqual(money.reversals.map((r) => [r.id, r.amountMinor, r.paused]), [[sentBack.reversal.id, 1_000, false]]);
  assert.deepEqual(money.held, { refunds: 1, transfers: 3 });

  const other = await world();
  const stranger = await operator(other.institutionId);
  assert.deepEqual(await moneyForOperator(stranger), { discrepancies: [], orphanedAccounts: [], disputes: [], reversals: [], held: { refunds: 0, transfers: 0 } });
  const [first, second] = money.discrepancies;
  assert.deepEqual(await resolveDiscrepancy({ operator: stranger, discrepancyId: first.id, note: "not mine" }), gone);
  assert.deepEqual(await recordManualSettlement({ operator: stranger, discrepancyId: second.id, note: "not mine" }), gone);
  assert.deepEqual(await liftDisputePause({ operator: stranger, disputeId: dispute.id, note: "not mine" }), gone);
  assert.deepEqual(await answerReversal({ operator: stranger, reversalId: sentBack.reversal.id, answer: "forfeited" }), gone);

  const unchanged = await moneyForOperator(ops);
  assert.deepEqual(
    [unchanged.discrepancies.length, unchanged.orphanedAccounts.length, unchanged.disputes.length, unchanged.reversals.length, unchanged.held],
    [2, 1, 1, 1, { refunds: 1, transfers: 3 }],
    "nothing was written",
  );
  assert.deepEqual((await rows(refused.engagementId, "tutor_transfer")).map((r) => r.stripeReference), [null]);
  await assertMoneyInvariants(w.institutionId);
});
