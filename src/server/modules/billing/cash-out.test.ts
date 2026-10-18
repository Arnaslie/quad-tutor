import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { ledgerEntry } from "@/server/db/schema";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { cashOut, cashOutOffer } from "./cash-out";
import { payoutsOf, syncConnectAccount } from "./connect";
import { fakeStripe } from "./stripe";
import { cleanup, delivered, noStripe, world } from "./test-world";
import { runTransfers } from "./transfers";

after(cleanup);

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const error = console.error;
  console.error = () => {};
  try {
    return await work();
  } finally {
    console.error = error;
  }
}

test("pay the sweep sent can be cashed out once, at the fee shown, and writes no ledger row", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  assert.equal((await runTransfers(w.institutionId, Date.now() + 10_000)).sent, 1);
  assert.equal(await cashOutOffer(await payoutsOf(w.tutor)), null);

  await fakeStripe.addDebitCard(w.accountId);
  const offer = await cashOutOffer(await payoutsOf(w.tutor));
  assert.deepEqual(offer, { grossMinor: 3_150, netMinor: 3_050, feeMinor: 100, currency: "usd" });

  const ledgerBefore = await db.select({ id: ledgerEntry.id }).from(ledgerEntry).where(eq(ledgerEntry.engagementId, engagementId));
  const requestId = randomUUID();
  const sent = { status: "sent", netMinor: 3_050, currency: "usd" };
  assert.deepEqual(
    await Promise.all([cashOut(w.tutor, { netMinor: 3_050, requestId }), cashOut(w.tutor, { netMinor: 3_050, requestId })]),
    [sent, sent],
  );

  assert.equal(await cashOutOffer(await payoutsOf(w.tutor)), null);
  assert.deepEqual(await cashOut(w.tutor, { netMinor: 3_050, requestId: randomUUID() }), { status: "unavailable" });
  assert.deepEqual(
    await db.select({ id: ledgerEntry.id }).from(ledgerEntry).where(eq(ledgerEntry.engagementId, engagementId)),
    ledgerBefore,
  );
  assert.deepEqual(await earningsForTutor(w.tutor), {
    earnedMinor: 3_150,
    owedMinor: 0,
    transferredMinor: 3_150,
    currency: "usd",
    sessionsDelivered: 1,
  });
});

test("a quote that moved since the tutor confirmed sends nothing, and two cash-outs at once send one", async () => {
  const w = await world();
  await fakeStripe.dashboardTransfer({ engagementId: randomUUID(), accountId: w.accountId, amountMinor: 200_000 });
  await fakeStripe.addDebitCard(w.accountId);
  assert.deepEqual(await cashOutOffer(await payoutsOf(w.tutor)), {
    grossMinor: 200_000,
    netMinor: 197_500,
    feeMinor: 2_500,
    currency: "usd",
  });

  assert.deepEqual(await cashOut(w.tutor, { netMinor: 197_400, requestId: randomUUID() }), { status: "changed" });
  assert.equal((await cashOutOffer(await payoutsOf(w.tutor)))?.netMinor, 197_500);

  const results = await quietly(() =>
    Promise.all([
      cashOut(w.tutor, { netMinor: 197_500, requestId: randomUUID() }),
      cashOut(w.tutor, { netMinor: 197_500, requestId: randomUUID() }),
    ]),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), ["sent", "unavailable"]);
  assert.equal(await cashOutOffer(await payoutsOf(w.tutor)), null);
});

test("a tutor Stripe no longer verifies sees no cash-out, and asking sends nothing to Stripe", async () => {
  const w = await world();
  await fakeStripe.dashboardTransfer({ engagementId: randomUUID(), accountId: w.accountId, amountMinor: 5_000 });
  await fakeStripe.addDebitCard(w.accountId);
  assert.equal((await cashOutOffer(await payoutsOf(w.tutor)))?.netMinor, 4_900);

  await fakeStripe.setAccount(w.accountId, "restricted");
  await syncConnectAccount(w.accountId);
  await noStripe(async () => {
    assert.equal(await cashOutOffer(await payoutsOf(w.tutor)), null);
    assert.deepEqual(await cashOut(w.tutor, { netMinor: 4_900, requestId: randomUUID() }), { status: "unavailable" });
  });
});
