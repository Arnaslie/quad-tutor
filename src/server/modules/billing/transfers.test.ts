import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, moneyDiscrepancy, paymentDispute, reliabilityEvent, sessionBooking, tutorProfile } from "@/server/db/schema";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { syncConnectAccount } from "./connect";
import { assertMoneyInvariants } from "./invariants";
import { GatewayError, fakeStripe, stripeGateway } from "./stripe";
import { age as ageRows, allCampuses, cleanup, deliver, delivered, noStripe, patched, person, rows, run, world, type World } from "./test-world";
import { runTransfers } from "./transfers";

const nothing = { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 0, failed: 0 };

async function discrepancies(engagementId: string) {
  return db
    .select({ kind: moneyDiscrepancy.kind, ledgerEntryId: moneyDiscrepancy.ledgerEntryId, ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor, stripeAmountMinor: moneyDiscrepancy.stripeAmountMinor })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.engagementId, engagementId));
}

/** Puts the transfer rows past the sweep's grace, as if the after-commit call died a while ago. */
const age = (engagementId: string) => ageRows(engagementId, "tutor_transfer", 10 * 60 * 1000);

const sweep = (w: World) => runTransfers(w.institutionId, Date.now() + 10_000);

/** The idempotency key of every transfer create while the work runs. */
async function creates(work: () => Promise<void>): Promise<string[]> {
  const keys: string[] = [];
  const real = stripeGateway().createTransfer;
  await patched("createTransfer", async (params) => {
    keys.push(params.idempotencyKey);
    return real(params);
  }, work);
  return keys;
}

after(cleanup);

test("a confirmed session's pay is transferred once, from the student's charge, and earnings show it sent", async () => {
  const w = await world();
  const { engagementId, paymentIntentId } = await delivered(w);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 3_150, transferredMinor: 0, currency: "usd", sessionsDelivered: 1 });

  assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
  const [row] = await rows(engagementId, "tutor_transfer");
  assert.equal(row.amountMinor, 3_150);
  assert.match(row.stripeReference!, /^tr_fake_/);
  assert.deepEqual(await stripeGateway().retrieveTransfer(row.stripeReference!), {
    id: row.stripeReference,
    amountMinor: 3_150,
    currency: "usd",
    destination: w.accountId,
    transferGroup: engagementId,
    sourceTransaction: paymentIntentId.replace(/^pi_/, "ch_"),
    ledgerEntryId: row.id,
    engagementId,
    institutionId: w.institutionId,
    reversals: [],
    reversedMinor: 0,
  });
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });

  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), nothing);
  }), []);
  assert.equal((await stripeGateway().listTransfers(engagementId)).length, 1);
});

test("past the $100 fee milestone the tutor is sent 95% of the session price", async () => {
  const w = await world();
  const { actor, engagementId } = await delivered(w);
  const feeMinor = 10_000 - 350;
  const earnedMinor = feeMinor * 10;
  const [earlier] = await db
    .insert(engagement)
    .values({ institutionId: w.institutionId, studentProfileId: actor.studentProfileId, tutorCourseId: w.tutorCourseId, courseOfferingId: w.offeringId, kind: "exam_anchored", status: "completed", sessionsPurchased: 1, pricePaidMinor: earnedMinor })
    .returning({ id: engagement.id });
  const [session] = await db
    .insert(sessionBooking)
    .values({ engagementId: earlier.id, institutionId: w.institutionId, scheduledAt: new Date(Date.now() - 72 * 3_600_000), status: "completed", resolution: "both_confirmed" })
    .returning({ id: sessionBooking.id });
  const row = { engagementId: earlier.id, institutionId: w.institutionId };
  const recognised = { ...row, sessionId: session.id };
  await db.insert(ledgerEntry).values([
    { ...row, type: "package_purchase", amountMinor: earnedMinor },
    { ...recognised, type: "session_earned", amountMinor: earnedMinor },
    { ...recognised, type: "tutor_accrued", amountMinor: earnedMinor - feeMinor },
    { ...recognised, type: "platform_fee", amountMinor: feeMinor },
  ]);

  const { engagementId: past } = await delivered(w);
  assert.deepEqual((await rows(past, "tutor_accrued")).map((r) => r.amountMinor), [3_325]);
  assert.deepEqual(await sweep(w), { ...nothing, sent: 2 });
  assert.deepEqual((await rows(past, "tutor_transfer")).map((r) => r.amountMinor), [3_325]);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.amountMinor), [3_150]);
  const [sent] = await rows(past, "tutor_transfer");
  assert.equal((await stripeGateway().retrieveTransfer(sent.stripeReference!)).amountMinor, 3_325);
});

test("a transfer whose response was lost is stamped by a later run from its metadata, never sent twice", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  fakeStripe.loseNextTransferResponse();
  assert.deepEqual(await sweep(w), { ...nothing, failed: 1 });
  const [made] = await stripeGateway().listTransfers(engagementId);
  assert.equal((await rows(engagementId, "tutor_transfer"))[0].stripeReference, null);

  assert.deepEqual(await sweep(w), nothing, "inside the grace the row is left alone, and nothing more is owed");
  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, settled: 1 });
  }), []);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => [r.amountMinor, r.stripeReference]), [[3_150, made.id]]);
  assert.equal((await stripeGateway().listTransfers(engagementId)).length, 1);
});

test("a lost transfer on an engagement disputed since is still stamped, and nothing new is created", async () => {
  const w = await world();
  const { engagementId, paymentIntentId } = await delivered(w);
  fakeStripe.loseNextTransferResponse();
  assert.deepEqual(await sweep(w), { ...nothing, failed: 1 });
  const [made] = await stripeGateway().listTransfers(engagementId);

  const dispute = await fakeStripe.dispute(paymentIntentId);
  await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.created"));
  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, settled: 1 });
  }), []);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => [r.amountMinor, r.stripeReference]), [[3_150, made.id]]);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });
});

test("a 500 Stripe replays under the base key moves the retry to the hour key, and one transfer is made", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  fakeStripe.failNextTransfer();
  assert.deepEqual(await sweep(w), { ...nothing, failed: 1 });
  assert.deepEqual(await stripeGateway().listTransfers(engagementId), []);
  const [row] = await rows(engagementId, "tutor_transfer");

  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, settled: 1 });
  }), [`transfer:${row.id}`, `transfer:${row.id}:0`]);
  const transfers = await stripeGateway().listTransfers(engagementId);
  assert.deepEqual(transfers.map((t) => t.amountMinor), [3_150]);
  assert.equal((await rows(engagementId, "tutor_transfer"))[0].stripeReference, transfers[0].id);
});

test("transfer events in any order and any number stamp once and record each reversal once", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  fakeStripe.loseNextTransferResponse();
  await sweep(w);
  const [made] = await stripeGateway().listTransfers(engagementId);
  const created = await fakeStripe.transferEvent(made.id, "transfer.created");
  const [reversal] = (await fakeStripe.reverseTransfer(made.id, 1_000)).reversals;
  const reversed = await fakeStripe.transferEvent(made.id, "transfer.reversed");

  const synced = { status: 200, outcome: "transfer_synced", institutionId: w.institutionId };
  for (const event of [reversed, reversed, created, created]) assert.deepEqual(await deliver(event), synced);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.stripeReference), [made.id]);
  assert.deepEqual((await rows(engagementId, "transfer_reversal")).map((r) => [r.amountMinor, r.stripeReference]), [[1_000, reversal.id]]);
  assert.deepEqual(await discrepancies(engagementId), []);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 1_000, transferredMinor: 2_150, currency: "usd", sessionsDelivered: 1 });

  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), nothing, "a reversal is ops' call; the sweep never re-sends it");
  }), []);
});

test("a tutor restricted during one create gets no more rows or creates in the same run", async () => {
  const w = await world();
  const first = await delivered(w);
  const second = await delivered(w);
  const real = stripeGateway().createTransfer;
  const keys: string[] = [];
  await patched("createTransfer", async (params) => {
    keys.push(params.idempotencyKey);
    await fakeStripe.setAccount(w.accountId, "restricted");
    return real(params);
  }, async () => {
    assert.deepEqual(await sweep(w), { ...nothing, waiting: 2 });
  });
  assert.equal(keys.length, 1);
  const sent = [...(await rows(first.engagementId, "tutor_transfer")), ...(await rows(second.engagementId, "tutor_transfer"))];
  assert.deepEqual(sent.map((r) => [r.amountMinor, r.stripeReference]), [[3_150, null]]);
});

test("a key Stripe says was used with other parameters is flagged rather than retried every run", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await patched("createTransfer", async () => {
    throw new GatewayError("Keys for idempotent requests can only be used with the same parameters.", { status: 400, idempotency: true });
  }, async () => {
    assert.deepEqual(await sweep(w), { ...nothing, flagged: 1, blocked: 1 });
  });
  const [row] = await rows(engagementId, "tutor_transfer");
  assert.deepEqual(await discrepancies(engagementId), [
    { kind: "ledger_vs_stripe_transfers", ledgerEntryId: row.id, ledgerAmountMinor: 3_150, stripeAmountMinor: null },
  ]);
  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 });
  }), []);
});

test("a fully reversed transfer stays owed and is never re-sent by the sweep", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await sweep(w);
  const [row] = await rows(engagementId, "tutor_transfer");
  await fakeStripe.reverseTransfer(row.stripeReference!);
  await deliver(await fakeStripe.transferEvent(row.stripeReference!, "transfer.reversed"));
  assert.deepEqual((await rows(engagementId, "transfer_reversal")).map((r) => r.amountMinor), [3_150]);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 3_150, transferredMinor: 0, currency: "usd", sessionsDelivered: 1 });

  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), nothing);
  }), []);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.amountMinor), [3_150]);
});

test("a second transfer naming an already stamped row is flagged and its reversals are not booked", async () => {
  const w = await world();
  const { engagementId, paymentIntentId } = await delivered(w);
  await sweep(w);
  const [row] = await rows(engagementId, "tutor_transfer");
  const stray = await stripeGateway().createTransfer({
    accountId: w.accountId,
    chargeId: paymentIntentId.replace(/^pi_/, "ch_"),
    amountMinor: 500,
    currency: "usd",
    engagementId,
    institutionId: w.institutionId,
    ledgerEntryId: row.id,
    idempotencyKey: `stray:${row.id}`,
  });
  await fakeStripe.reverseTransfer(stray.id);

  assert.deepEqual(await deliver(await fakeStripe.transferEvent(stray.id, "transfer.reversed")), {
    status: 200,
    outcome: "flagged",
    institutionId: w.institutionId,
  });
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.stripeReference), [row.stripeReference]);
  assert.deepEqual(await rows(engagementId, "transfer_reversal"), []);
  assert.deepEqual(await discrepancies(engagementId), [
    { kind: "ledger_vs_stripe_transfers", ledgerEntryId: row.id, ledgerAmountMinor: 3_150, stripeAmountMinor: 500 },
  ]);
});

test("a transfer that disagrees with its ledger row is stamped and flagged, and a foreign one is ignored", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await sweep(w);
  const [row] = await rows(engagementId, "tutor_transfer");
  const event = await fakeStripe.transferEvent(row.stripeReference!, "transfer.created");
  const real = stripeGateway().retrieveTransfer;
  await patched("retrieveTransfer", async (id) => ({ ...(await real(id)), amountMinor: 3_000 }), async () => {
    assert.deepEqual(await deliver(event), { status: 200, outcome: "transfer_synced", institutionId: w.institutionId });
  });
  assert.deepEqual(await discrepancies(engagementId), [
    { kind: "ledger_vs_stripe_transfers", ledgerEntryId: row.id, ledgerAmountMinor: 3_150, stripeAmountMinor: 3_000 },
  ]);

  const foreign = { status: 200, outcome: "foreign", institutionId: null };
  await patched("retrieveTransfer", async (id) => ({ ...(await real(id)), ledgerEntryId: null }), async () => {
    assert.deepEqual(await deliver(event), foreign);
  });
  await patched("retrieveTransfer", async (id) => ({ ...(await real(id)), ledgerEntryId: randomUUID() }), async () => {
    assert.deepEqual(await deliver(event), foreign);
  });
  await patched("retrieveTransfer", async () => { throw new GatewayError("No such transfer", { status: 404, code: "resource_missing" }); }, async () => {
    assert.deepEqual(await deliver(event), foreign);
  });
});

test("a tutor Stripe no longer verifies is sent nothing and their status follows Stripe, until verified again", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await fakeStripe.setAccount(w.accountId, "restricted");
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, waiting: 1 });
  }), []);
  assert.deepEqual(await rows(engagementId, "tutor_transfer"), []);
  const kyc = async () => (await db.select({ status: tutorProfile.kycStatus }).from(tutorProfile).where(eq(tutorProfile.id, w.tutor.tutorProfileId)))[0].status;
  assert.equal(await kyc(), "restricted");
  assert.deepEqual(await sweep(w), { ...nothing, waiting: 0 }, "the stored status now keeps the sweep off Stripe");

  await fakeStripe.setAccount(w.accountId, "verified");
  await syncConnectAccount(w.accountId);
  assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
  assert.equal((await rows(engagementId, "tutor_transfer"))[0].amountMinor, 3_150);
});

test("an account restricted between the check and the create waits, then is paid on a fresh key once verified", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  const real = stripeGateway().createTransfer;
  await patched("createTransfer", async (params) => {
    await fakeStripe.setAccount(w.accountId, "restricted");
    return real(params);
  }, async () => {
    assert.deepEqual(await sweep(w), { ...nothing, waiting: 1 });
  });
  const [row] = await rows(engagementId, "tutor_transfer");
  assert.equal(row.stripeReference, null);
  assert.deepEqual(await discrepancies(engagementId), []);

  await fakeStripe.setAccount(w.accountId, "verified");
  await syncConnectAccount(w.accountId);
  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, settled: 1 });
  }), [`transfer:${row.id}`, `transfer:${row.id}:0`], "the base key replays the old refusal for a day");
  assert.deepEqual(await discrepancies(engagementId), []);
  assert.match((await rows(engagementId, "tutor_transfer"))[0].stripeReference!, /^tr_fake_/);
});

test("a transfer refused for a verified tutor is flagged, and the engagement stays blocked with no more creates", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await patched("createTransfer", async () => { throw new GatewayError("Insufficient funds.", { status: 400, code: "balance_insufficient" }); }, async () => {
    assert.deepEqual(await sweep(w), { ...nothing, flagged: 1, blocked: 1 });
  });
  const [row] = await rows(engagementId, "tutor_transfer");
  assert.equal(row.stripeReference, null);
  assert.deepEqual(await discrepancies(engagementId), [{ kind: "ledger_vs_stripe_transfers", ledgerEntryId: row.id, ledgerAmountMinor: 3_150, stripeAmountMinor: null }]);

  await age(engagementId);
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 });
    assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 });
  }), []);

  await db.update(moneyDiscrepancy).set({ resolvedAt: new Date() }).where(eq(moneyDiscrepancy.engagementId, engagementId));
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 }, "resolving never re-arms the row; ops settles it");
  }), []);
});

test("a chargeback pauses transfers, Stripe closing it does not lift the pause, and only ops does", async () => {
  const w = await world();
  const { actor, engagementId, paymentIntentId } = await delivered(w);
  const facts = async () => (await db.select({ id: reliabilityEvent.id }).from(reliabilityEvent).where(eq(reliabilityEvent.userId, actor.userId))).length;
  const factsBefore = await facts();

  const dispute = await fakeStripe.dispute(paymentIntentId);
  const opened = await fakeStripe.disputeEvent(dispute.id, "charge.dispute.created");
  const recorded = { status: 200, outcome: "dispute_recorded", institutionId: w.institutionId };
  assert.deepEqual(await deliver(opened), recorded);
  assert.deepEqual(await deliver(opened), recorded);
  const record = async () =>
    db
      .select({ engagementId: paymentDispute.engagementId, status: paymentDispute.status, reason: paymentDispute.reason, amountMinor: paymentDispute.amountMinor, closedAt: paymentDispute.closedAt, resolvedAt: paymentDispute.resolvedAt })
      .from(paymentDispute)
      .where(eq(paymentDispute.stripeDisputeId, dispute.id));
  assert.deepEqual(await record(), [{ engagementId, status: "needs_response", reason: "fraudulent", amountMinor: 14_000, closedAt: null, resolvedAt: null }]);

  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 });
  }), []);

  await fakeStripe.closeDispute(dispute.id, "won");
  assert.deepEqual(await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.closed")), recorded);
  const [closed] = await record();
  assert.equal(closed.status, "won");
  assert.ok(closed.closedAt);
  assert.deepEqual(await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.funds_reinstated")), recorded);
  assert.deepEqual((await record()).map((r) => r.closedAt), [closed.closedAt], "closed once");
  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), { ...nothing, blocked: 1 });
  }), []);
  assert.equal(await facts(), factsBefore, "a chargeback writes no reliability fact");

  await db.update(paymentDispute).set({ resolvedAt: new Date(), resolutionNote: "won; nothing owed back" }).where(eq(paymentDispute.stripeDisputeId, dispute.id));
  assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
});

test("a closed dispute keeps its status when a stale open state arrives late", async () => {
  const w = await world();
  const { paymentIntentId } = await delivered(w);
  const dispute = await fakeStripe.dispute(paymentIntentId);
  await fakeStripe.closeDispute(dispute.id, "won");
  await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.closed"));
  const record = async () =>
    db
      .select({ status: paymentDispute.status, closedAt: paymentDispute.closedAt })
      .from(paymentDispute)
      .where(eq(paymentDispute.stripeDisputeId, dispute.id));
  const [closed] = await record();
  assert.equal(closed.status, "won");

  const real = stripeGateway().retrieveDispute;
  await patched("retrieveDispute", async (id) => ({ ...(await real(id)), status: "needs_response" }), async () => {
    await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.updated"));
  });
  assert.deepEqual(await record(), [{ status: "won", closedAt: closed.closedAt }]);
});

test("a dispute on a payment no package was bought with is foreign", async () => {
  const w = await world();
  const { paymentIntentId } = await delivered(w);
  const dispute = await fakeStripe.dispute(paymentIntentId);
  const real = stripeGateway().retrieveDispute;
  await patched("retrieveDispute", async (id) => ({ ...(await real(id)), paymentIntentId: `pi_elsewhere_${run}` }), async () => {
    assert.deepEqual(await deliver(await fakeStripe.disputeEvent(dispute.id, "charge.dispute.created")), { status: 200, outcome: "foreign", institutionId: null });
  });
  assert.deepEqual(await db.select({ id: paymentDispute.id }).from(paymentDispute).where(eq(paymentDispute.stripeDisputeId, dispute.id)), []);
});

test("an engagement bought before Stripe is never sent, and the sweep makes no Stripe call for it", async () => {
  const w = await world();
  const actor = await person(w.institutionId);
  const [legacy] = await db
    .insert(engagement)
    .values({ institutionId: w.institutionId, studentProfileId: actor.studentProfileId, tutorCourseId: w.tutorCourseId, courseOfferingId: w.offeringId, kind: "exam_anchored", sessionsPurchased: 4, pricePaidMinor: 14_000 })
    .returning({ id: engagement.id });
  const [done] = await db
    .insert(sessionBooking)
    .values({ engagementId: legacy.id, institutionId: w.institutionId, scheduledAt: new Date(Date.now() - 72 * 3_600_000), status: "completed", resolution: "both_confirmed" })
    .returning({ id: sessionBooking.id });
  const row = { engagementId: legacy.id, institutionId: w.institutionId };
  const recognised = { ...row, sessionId: done.id };
  await db.insert(ledgerEntry).values([
    { ...row, type: "package_purchase", amountMinor: 14_000 },
    { ...recognised, type: "session_earned", amountMinor: 3_500 },
    { ...recognised, type: "tutor_accrued", amountMinor: 3_150 },
    { ...recognised, type: "platform_fee", amountMinor: 350 },
  ]);

  await noStripe(async () => {
    assert.deepEqual(await sweep(w), nothing);
  });
  assert.deepEqual(await rows(legacy.id, "tutor_transfer"), []);
});

test("money invariants hold on every campus after every transfer path", async () => {
  const w = await world();
  await delivered(w);
  assert.deepEqual(await sweep(w), { ...nothing, sent: 1 });
  for (const institutionId of allCampuses()) await assertMoneyInvariants(institutionId);
});

test("lifetime earnings past $21M still add up", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await db.insert(ledgerEntry).values(
    Array.from({ length: 22 }, () => ({ engagementId, institutionId: w.institutionId, type: "tutor_accrued" as const, amountMinor: 99_999_999 })),
  );
  assert.equal((await earningsForTutor(w.tutor)).earnedMinor, 2_200_003_128);
});
