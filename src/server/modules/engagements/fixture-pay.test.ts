import assert from "node:assert/strict";
import { after, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, sessionBooking } from "@/server/db/schema";
import { checkMoneyInvariants } from "@/server/modules/billing/invariants";
import { retryUnstampedRefunds, refundThroughStripe } from "@/server/modules/billing/refunds";
import { accepted, age, cleanup, delivered, firstSessionDelivered, newestRefund, noStripe, rows, world } from "@/server/modules/billing/test-world";
import { runTransfers } from "@/server/modules/billing/transfers";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { pay } from "./buy-and-pay";
import { fixturePay, fixturePayout } from "./fixture-pay";
import { endPackage } from "./termEnd";

const PERSONA = "persona_test";
const nothingSent = { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 0, failed: 0 };

after(cleanup);

async function inProduction(work: () => Promise<void>) {
  const before = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    await work();
  } finally {
    if (before === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = before;
  }
}

async function status(engagementId: string) {
  const [row] = await db.select({ status: engagement.status }).from(engagement).where(eq(engagement.id, engagementId));
  return row.status;
}

test("a persona package is paid with fixture money in production, split by the real code, without a Stripe call", async () => {
  const w = await world(PERSONA);
  const { actor, buy } = await accepted(w);
  const result = await buy();
  assert.equal(result.outcome, "checkout");
  const { engagementId } = result;

  await noStripe(() =>
    inProduction(async () => {
      await assert.rejects(pay(result), /Fake payments are refused in production/);
      assert.deepEqual(await fixturePay(result), { engagementId });
    }),
  );

  assert.equal(await status(engagementId), "active");
  const [purchase] = await rows(engagementId, "package_purchase");
  assert.equal(purchase.amountMinor, 14_000);
  assert.match(purchase.stripeReference!, /^fixture_pi_[0-9a-f-]{36}$/);
  assert.deepEqual(await rows(engagementId, "processor_fee"), []);

  await noStripe(async () => {
    await firstSessionDelivered(w, actor, engagementId);
    assert.deepEqual(await runTransfers(w.institutionId, Date.now() + 10_000), nothingSent);
  });
  assert.deepEqual((await rows(engagementId, "tutor_accrued")).map((r) => r.amountMinor), [3_150]);
  assert.deepEqual(await rows(engagementId, "tutor_transfer"), []);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 3_150, transferredMinor: 0, currency: "usd", sessionsDelivered: 1 });

  await noStripe(async () => {
    assert.deepEqual(await fixturePayout({ engagementId, institutionId: w.institutionId }), { transferredMinor: 3_150 });
    assert.deepEqual(await fixturePayout({ engagementId, institutionId: w.institutionId }), { transferredMinor: 0 });
  });
  const transfers = await rows(engagementId, "tutor_transfer");
  assert.deepEqual(transfers.map((r) => r.amountMinor), [3_150]);
  assert.match(transfers[0].stripeReference!, /^fixture_tr_[0-9a-f-]{36}$/);
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });

  await age(engagementId, "tutor_transfer", 10 * 60 * 1000);
  await noStripe(async () => {
    assert.deepEqual(await runTransfers(w.institutionId, Date.now() + 10_000), nothingSent);
  });
  assert.deepEqual(await checkMoneyInvariants(w.institutionId), []);
});

test("fixture money is refused unless both the student and the tutor are personas", async () => {
  const realTutor = await world();
  const personaTutor = await world(PERSONA);

  for (const [w, studentPrefix] of [[realTutor, PERSONA], [personaTutor, "test_money"]] as const) {
    const { buy } = await accepted(w, studentPrefix);
    const result = await buy();
    assert.equal(result.outcome, "checkout");
    await noStripe(() => assert.rejects(fixturePay(result), /both sides must be personas/));
    assert.equal(await status(result.engagementId), "pending_payment");
    assert.deepEqual(await rows(result.engagementId, "package_purchase"), []);
  }
});

test("a persona package bought through Stripe is never marked paid out with fixture money", async () => {
  const w = await world(PERSONA);
  const { engagementId } = await delivered(w);
  await noStripe(() =>
    assert.rejects(fixturePayout({ engagementId, institutionId: w.institutionId }), /was not bought with fixture money/),
  );
  assert.deepEqual(await rows(engagementId, "tutor_transfer"), []);
});

test("ending a fixture package books its refund and never sends it to Stripe", async () => {
  const w = await world(PERSONA);
  const { actor, buy } = await accepted(w);
  const { engagementId } = await fixturePay(await buy());
  await db
    .update(sessionBooking)
    .set({ scheduledAt: new Date(Date.now() + 48 * 3_600_000) })
    .where(eq(sessionBooking.engagementId, engagementId));

  await noStripe(async () => {
    assert.notEqual(await endPackage({ actor, engagementId }), null);
    assert.equal(await refundThroughStripe(await newestRefund(engagementId)), "skipped");
    await age(engagementId, "refund", 10 * 60 * 1000);
    assert.deepEqual(await retryUnstampedRefunds(w.institutionId, Date.now() + 10_000), { settled: 0, flagged: 0, blocked: 0, failed: 0 });
  });
  const [refund] = await rows(engagementId, "refund");
  assert.deepEqual([refund.amountMinor, refund.stripeReference], [14_000, null]);
  assert.deepEqual(await checkMoneyInvariants(w.institutionId), []);
});

test("the money check rejects a fixture reference unless both the student and the tutor are personas", async () => {
  for (const [tutorPrefix, studentPrefix] of [["test_money", "test_money"], [PERSONA, "test_money"], ["test_money", PERSONA]]) {
    const w = await world(tutorPrefix);
    const { actor, buy } = await accepted(w, studentPrefix);
    const { engagementId } = await pay(await buy());
    await firstSessionDelivered(w, actor, engagementId);
    await db
      .update(ledgerEntry)
      .set({ stripeReference: sql`'fixture_pi_' || ${ledgerEntry.id}` })
      .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "package_purchase")));

    assert.deepEqual(
      (await checkMoneyInvariants(w.institutionId)).map((v) => [v.invariant, v.subject]),
      [["fixture reference only between personas", `engagement ${engagementId}`]],
    );
  }
});
