import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  institution,
  ledgerEntry,
  matchRequest,
  messageThread,
  moneyDiscrepancy,
  sessionBooking,
  studentProfile,
  sweepLease,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { purchasePackage, slotsForRequest } from "@/server/modules/engagements/purchase";
import { endPackage, runTermEndRefunds } from "@/server/modules/engagements/termEnd";
import type { Actor, OperatorActor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";

import { checkoutRedirect, syncCheckout } from "./checkout-session";
import { recordRefundFailure } from "./discrepancy";
import { assertMoneyInvariants } from "./invariants";
import { recordManualSettlement } from "./ops";
import { blockedRefunds, refundThroughStripe, retryUnstampedRefunds } from "./refunds";
import { GatewayError, fakeStripe, stripeGateway, type Gateway } from "./stripe";
import { handleStripeWebhook } from "./webhook";

process.env.STRIPE_FAKE = "1";
process.env.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(16).toString("hex")}`;
delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const users: string[] = [];
let home: { institutionId: string; offeringId: string; endedOfferingId: string };
let tutor: TutorActor;
let tutorCourseId: string;

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

let people = 0;
async function person(): Promise<Actor> {
  const id = `test_refund_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  users.push(id);
  const [profile] = await db
    .insert(studentProfile)
    .values({ userId: id, institutionId: home.institutionId })
    .returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId: home.institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

/** A four-pack paid through the fake, its one session moved two days out so ending early is allowed. */
async function bought() {
  const actor = await person();
  await requestTutors({ actor, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  const [request] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, actor.studentProfileId), eq(matchRequest.status, "pending")));
  await acceptRequest({ tutor, requestId: request.id });
  const [slot] = await slotsForRequest({ actor, requestId: request.id });
  await checkoutRedirect(home.institutionId, () => purchasePackage({ actor, requestId: request.id, anchorExamId: null, slotStartsAt: slot }));
  const [row] = await db
    .select({ id: engagement.id, sessionId: engagement.stripeCheckoutSessionId })
    .from(engagement)
    .where(and(eq(engagement.studentProfileId, actor.studentProfileId), eq(engagement.status, "pending_payment")));
  await fakeStripe.pay(row.sessionId!);
  assert.equal((await syncCheckout(row.sessionId!)).outcome, "fulfilled");
  await db.update(sessionBooking).set({ scheduledAt: new Date(Date.now() + 48 * 3_600_000) }).where(eq(sessionBooking.engagementId, row.id));
  return { actor, engagementId: row.id, checkoutSessionId: row.sessionId! };
}

const ids = (engagementId: string) => ({ engagementId, institutionId: home.institutionId });

async function operator(institutionId = home.institutionId): Promise<OperatorActor> {
  return { ...(await person()), operatorInstitutionIds: [institutionId] };
}

async function refundRow(engagementId: string) {
  const [row] = await db
    .select({ id: ledgerEntry.id, amountMinor: ledgerEntry.amountMinor, stripeReference: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "refund")));
  return row;
}

async function discrepancies(engagementId: string) {
  return db
    .select({ kind: moneyDiscrepancy.kind, stripeReference: moneyDiscrepancy.stripeReference, ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.engagementId, engagementId));
}

/** Puts the row past the sweep's grace, as if the after-commit call died a while ago. */
async function age(engagementId: string, ms = 10 * 60 * 1000) {
  await db
    .update(ledgerEntry)
    .set({ occurredAt: new Date(Date.now() - ms) })
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "refund")));
}

async function patched<K extends keyof Gateway>(name: K, replacement: Gateway[K], work: () => Promise<void>) {
  const gateway = stripeGateway();
  const original = gateway[name];
  gateway[name] = replacement;
  try {
    await work();
  } finally {
    gateway[name] = original;
  }
}

let realRefund: Gateway["refund"];

/** Stripe makes the refund, then the response is lost on the way back. */
const lostResponse: Gateway["refund"] = async (params) => {
  await realRefund(params);
  throw new GatewayError("socket hang up");
};

/** The retry sweep's own work; `blocked` counts the whole campus and is checked on its own. */
async function sweep() {
  const { settled, flagged, failed } = await retryUnstampedRefunds(home.institutionId, Date.now() + 10_000);
  return { settled, flagged, failed };
}

/** Counts every refund create while the work runs. */
async function creates(work: () => Promise<void>): Promise<number> {
  let calls = 0;
  await patched("refund", async (params) => {
    calls += 1;
    return realRefund(params);
  }, work);
  return calls;
}

const refused = async () => {
  throw new GatewayError("This charge is disputed.", { status: 400, code: "charge_disputed" });
};

async function deliver(refundId: string, type: Parameters<typeof fakeStripe.refundEvent>[1]) {
  const { payload, signature } = await fakeStripe.refundEvent(refundId, type);
  return handleStripeWebhook(payload, signature);
}

before(async () => {
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test refunds", slug: `refunds-${run}`, emailDomain: `refunds-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  const [now] = await db.insert(term).values({ institutionId: inst.id, name: "Now", startsOn: inDays(-30), endsOn: inDays(60) }).returning({ id: term.id });
  const [last] = await db.insert(term).values({ institutionId: inst.id, name: "Last", startsOn: inDays(-200), endsOn: inDays(-100) }).returning({ id: term.id });
  const [courseRow] = await db.insert(course).values({ institutionId: inst.id, title: "Refunds 101", department: "TEST" }).returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `REF ${run}` });
  const [offering, ended] = await db
    .insert(courseOffering)
    .values([
      { institutionId: inst.id, courseId: courseRow.id, termId: now.id, section: "001" },
      { institutionId: inst.id, courseId: courseRow.id, termId: last.id, section: "002" },
    ])
    .returning({ id: courseOffering.id });
  home = { institutionId: inst.id, offeringId: offering.id, endedOfferingId: ended.id };

  const base = await person();
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId: inst.id }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tutorProfileId: profile.id, institutionId: inst.id, weekday, startMinute: 8 * 60, endMinute: 20 * 60 })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId: inst.id, courseId: courseRow.id, takenTermId: now.id, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  tutor = { ...base, tutorProfileId: profile.id };
  tutorCourseId = claim.id;
  realRefund = stripeGateway().refund;
});

after(async () => {
  const institutionId = home.institutionId;
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(eq(engagement.institutionId, institutionId))).map((row) => row.id);
  if (engagements.length) {
    await db.delete(moneyDiscrepancy).where(inArray(moneyDiscrepancy.engagementId, engagements));
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
  await db.delete(matchRequest).where(eq(matchRequest.institutionId, institutionId));
  await db.delete(messageThread).where(eq(messageThread.institutionId, institutionId));
  await db.delete(tutorAvailability).where(eq(tutorAvailability.institutionId, institutionId));
  await db.delete(tutorCourse).where(eq(tutorCourse.institutionId, institutionId));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, users));
  await db.delete(user).where(inArray(user.id, users));
  await db.delete(courseOffering).where(eq(courseOffering.institutionId, institutionId));
  await db.delete(courseCodeAlias).where(eq(courseCodeAlias.institutionId, institutionId));
  await db.delete(course).where(eq(course.institutionId, institutionId));
  await db.delete(term).where(eq(term.institutionId, institutionId));
  await db.delete(sweepLease).where(eq(sweepLease.institutionId, institutionId));
  await db.delete(institution).where(eq(institution.id, institutionId));
  await db.$client.end();
});

test("ending early writes the refund row unstamped, then refunds it through Stripe once and stamps the re_", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  assert.equal((await endPackage({ actor, engagementId }))?.refundMinor, 14_000);
  const row = await refundRow(engagementId);
  assert.equal(row.stripeReference, null, "the locked transaction never calls Stripe");

  assert.equal(await refundThroughStripe(ids(engagementId)), "refunded");
  const [refund] = await fakeStripe.refunds(checkoutSessionId);
  assert.deepEqual(
    { amountMinor: refund.amountMinor, ledgerEntryId: refund.ledgerEntryId, engagementId: refund.engagementId, institutionId: refund.institutionId },
    { amountMinor: 14_000, ledgerEntryId: row.id, engagementId, institutionId: home.institutionId },
  );
  assert.equal((await refundRow(engagementId)).stripeReference, refund.id);

  assert.equal(await refundThroughStripe(ids(engagementId)), "skipped");
  await age(engagementId);
  assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
});

test("the term-end sweep refunds only the undelivered sessions through Stripe", async () => {
  const { engagementId, checkoutSessionId } = await bought();
  const [delivered] = await db
    .insert(sessionBooking)
    .values({ engagementId, institutionId: home.institutionId, scheduledAt: new Date(Date.now() - 72 * 3_600_000), confirmationWindowEndsAt: new Date(Date.now() - 47 * 3_600_000), status: "completed", resolution: "both_confirmed" })
    .returning({ id: sessionBooking.id });
  const row = { engagementId, sessionId: delivered.id, institutionId: home.institutionId };
  await db.insert(ledgerEntry).values([
    { ...row, type: "session_earned", amountMinor: 3_500 },
    { ...row, type: "tutor_accrued", amountMinor: 3_150 },
    { ...row, type: "platform_fee", amountMinor: 350 },
  ]);
  await db.update(engagement).set({ courseOfferingId: home.endedOfferingId }).where(eq(engagement.id, engagementId));

  const swept = await runTermEndRefunds(home.institutionId);
  assert.deepEqual(swept.refunds.map((r) => [r.engagementId, r.refundMinor]), [[engagementId, 10_500]]);
  const [refund] = await fakeStripe.refunds(checkoutSessionId);
  assert.equal(refund.amountMinor, 10_500);
  assert.equal((await refundRow(engagementId)).stripeReference, refund.id);
});

test("a call whose response was lost is finished by the sweep from the refund's metadata, never refunded twice", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await patched("refund", lostResponse, async () => {
    await assert.rejects(refundThroughStripe(ids(engagementId)), /socket hang up/);
  });
  assert.equal((await refundRow(engagementId)).stripeReference, null);

  assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 }, "inside the grace the sweep leaves it alone");
  await age(engagementId);
  await patched("refund", async () => { throw new Error("must not create: the refund already exists"); }, async () => {
    assert.deepEqual(await sweep(), { settled: 1, flagged: 0, failed: 0 });
  });
  const refunds = await fakeStripe.refunds(checkoutSessionId);
  assert.equal(refunds.length, 1);
  assert.equal((await refundRow(engagementId)).stripeReference, refunds[0].id);
});

test("an errored create is retried on a fresh key, since the first key replays the error for a day", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  fakeStripe.failNextRefund();
  await assert.rejects(refundThroughStripe(ids(engagementId)), /unknown error/);
  await assert.rejects(refundThroughStripe(ids(engagementId)), /unknown error/, "the same key replays Stripe's cached 500");

  await age(engagementId);
  assert.deepEqual(await sweep(), { settled: 1, flagged: 0, failed: 0 });
  const [refund] = await fakeStripe.refunds(checkoutSessionId);
  assert.equal(refund.amountMinor, 14_000);
  assert.equal((await refundRow(engagementId)).stripeReference, refund.id);
});

test("the charge.refunded backstop stamps a refund the after-commit step never did, and repeats change nothing", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await patched("refund", lostResponse, async () => {
    await assert.rejects(refundThroughStripe(ids(engagementId)), /socket hang up/);
  });
  const [refund] = await fakeStripe.refunds(checkoutSessionId);

  const { payload, signature } = await fakeStripe.refundEvent(refund.id, "charge.refunded");
  const expected = { status: 200, outcome: "refunded", institutionId: home.institutionId };
  assert.deepEqual(await handleStripeWebhook(payload, signature), expected);
  assert.deepEqual(await handleStripeWebhook(payload, signature), expected);
  assert.deepEqual(await deliver(refund.id, "charge.refunded"), expected);
  assert.deepEqual(await deliver(refund.id, "refund.updated"), expected);
  assert.equal((await refundRow(engagementId)).stripeReference, refund.id);
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
  assert.deepEqual(await discrepancies(engagementId), []);
});

test("a refund that fails after creation is flagged for ops, keeps its stamp, and is never re-issued", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await refundThroughStripe(ids(engagementId));
  const [created] = await fakeStripe.refunds(checkoutSessionId);
  const late = await fakeStripe.refundEvent(created.id, "charge.refunded");

  await fakeStripe.failRefund(created.id);
  const failed = { status: 200, outcome: "refund_failed", institutionId: home.institutionId };
  assert.deepEqual(await deliver(created.id, "refund.failed"), failed);
  assert.deepEqual(await deliver(created.id, "charge.refund.updated"), failed);
  assert.deepEqual(await handleStripeWebhook(late.payload, late.signature), failed, "a stale charge.refunded re-reads the refund and sees it failed");
  assert.deepEqual(await discrepancies(engagementId), [{ kind: "refund_failed", stripeReference: created.paymentIntentId, ledgerAmountMinor: 14_000 }]);
  assert.equal((await refundRow(engagementId)).stripeReference, created.id);

  await age(engagementId);
  await sweep();
  assert.equal(await refundThroughStripe(ids(engagementId)), "skipped");
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
});

test("a failure reported before the stamp is stamped and flagged, and the sweep stays off the engagement", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await patched("refund", async (params) => fakeStripe.failRefund((await realRefund(params)).id), async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "refund_failed");
  });
  const [refund] = await fakeStripe.refunds(checkoutSessionId);
  assert.equal((await refundRow(engagementId)).stripeReference, refund.id);
  assert.deepEqual((await discrepancies(engagementId)).map((d) => d.kind), ["refund_failed"]);
});

test("a create Stripe refuses outright is flagged, and resolving the flag never re-arms a refund", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await patched("refund", refused, async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "refund_failed");
  });
  assert.equal((await refundRow(engagementId)).stripeReference, null);
  assert.deepEqual((await discrepancies(engagementId)).map((d) => [d.kind, d.ledgerAmountMinor]), [["refund_failed", 14_000]]);

  await db.update(moneyDiscrepancy).set({ resolvedAt: new Date() }).where(eq(moneyDiscrepancy.engagementId, engagementId));
  await age(engagementId);
  const calls = await creates(async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "skipped");
    assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
  });
  assert.equal(calls, 0);
  assert.deepEqual(await fakeStripe.refunds(checkoutSessionId), []);
});

test("ops settling by hand stamps the row manual:<discrepancy>, resolves the flag, and the sweep stays away", async () => {
  const { actor, engagementId } = await bought();
  await endPackage({ actor, engagementId });
  await patched("refund", refused, async () => {
    await refundThroughStripe(ids(engagementId));
  });
  const [flag] = await db.select({ id: moneyDiscrepancy.id }).from(moneyDiscrepancy).where(eq(moneyDiscrepancy.engagementId, engagementId));

  const ops = await operator();
  const gone = { ok: false, refusal: "gone" };
  assert.deepEqual(await recordManualSettlement({ operator: await operator(randomUUID()), discrepancyId: flag.id, note: "wrong campus" }), gone);
  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: flag.id, note: "Zelle, ops ticket 12" }), { ok: true });
  assert.deepEqual(await recordManualSettlement({ operator: ops, discrepancyId: flag.id, note: "again" }), gone);
  assert.equal((await refundRow(engagementId)).stripeReference, `manual:${flag.id}`);
  const [resolved] = await db
    .select({ at: moneyDiscrepancy.resolvedAt, note: moneyDiscrepancy.resolutionNote, by: moneyDiscrepancy.resolvedByUserId })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.id, flag.id));
  assert.ok(resolved.at);
  assert.deepEqual([resolved.note, resolved.by], ["Zelle, ops ticket 12", ops.userId]);

  await age(engagementId);
  assert.equal(await creates(async () => {
    await sweep();
  }), 0);
  await assertMoneyInvariants(home.institutionId);
});

test("a sweep overlapping the after-commit call gets the in-flight 409, leaves the row, and nothing is refunded twice", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await age(engagementId);
  const release = fakeStripe.holdRefunds();
  const first = refundThroughStripe(ids(engagementId));
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
  } finally {
    release();
  }
  assert.equal(await first, "refunded");
  assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
  assert.deepEqual(await discrepancies(engagementId), []);
});

test("a refund on the charge that is not ours, such as one made in the Dashboard, is flagged instead of refunded again", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  const [paid] = await db
    .select({ pi: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "package_purchase")));
  const dashboard = await realRefund({ paymentIntentId: paid.pi!, engagementId, institutionId: home.institutionId, amountMinor: 5_000, idempotencyKey: `dashboard-${engagementId}` });
  await endPackage({ actor, engagementId });

  const calls = await creates(async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "flagged");
    await age(engagementId);
    assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
  });
  assert.equal(calls, 0);
  assert.deepEqual(await discrepancies(engagementId), [{ kind: "ledger_vs_stripe_charge", stripeReference: dashboard.id, ledgerAmountMinor: 14_000 }]);
  assert.equal((await refundRow(engagementId)).stripeReference, null);
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
});

test("an already-refunded answer is settled with the refund Stripe holds, not flagged as failed", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  const row = await refundRow(engagementId);
  const [paid] = await db
    .select({ pi: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "package_purchase")));
  const earlier = await realRefund({ paymentIntentId: paid.pi!, engagementId, institutionId: home.institutionId, amountMinor: 14_000, ledgerEntryId: row.id, idempotencyKey: `refund:${row.id}:earlier` });

  const list = stripeGateway().listRefunds;
  let blind = true;
  await patched("listRefunds", async (pi) => (blind ? ((blind = false), []) : list(pi)), async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "refunded");
  });
  assert.equal((await refundRow(engagementId)).stripeReference, earlier.id);
  assert.deepEqual(await discrepancies(engagementId), []);
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
});

test("auth and lookup errors are transient: logged and retried, never flagged as a failed refund", async () => {
  const { actor, engagementId } = await bought();
  await endPackage({ actor, engagementId });
  for (const status of [401, 403, 404]) {
    await patched("refund", async () => { throw new GatewayError(`status ${status}`, { status, code: status === 404 ? "resource_missing" : undefined }); }, async () => {
      await assert.rejects(refundThroughStripe(ids(engagementId)), new RegExp(`status ${status}`));
    });
  }
  assert.deepEqual(await discrepancies(engagementId), []);
  assert.equal((await refundRow(engagementId)).stripeReference, null);
  assert.equal(await refundThroughStripe(ids(engagementId)), "refunded");
});

test("an engagement bought before Stripe is closed on the ledger and never sent to Stripe", async () => {
  const actor = await person();
  const [legacy] = await db
    .insert(engagement)
    .values({ institutionId: home.institutionId, studentProfileId: actor.studentProfileId, tutorCourseId, courseOfferingId: home.offeringId, kind: "exam_anchored", sessionsPurchased: 4, pricePaidMinor: 14_000 })
    .returning({ id: engagement.id });
  await db.insert(ledgerEntry).values({ engagementId: legacy.id, institutionId: home.institutionId, type: "package_purchase", amountMinor: 14_000 });

  assert.equal((await endPackage({ actor, engagementId: legacy.id }))?.refundMinor, 14_000);
  await age(legacy.id);
  const untouchable = async () => { throw new Error("no Stripe call for a pre-Stripe engagement"); };
  await patched("refund", untouchable, () =>
    patched("listRefunds", untouchable, async () => {
      assert.equal(await refundThroughStripe(ids(legacy.id)), "skipped");
      assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
    }),
  );
  assert.equal((await refundRow(legacy.id)).stripeReference, null);
});

test("a second sweep on the same campus is skipped while the first holds the lease", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await age(engagementId);
  const release = fakeStripe.holdRefunds();
  const first = sweep();
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await creates(async () => {
      assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
    }), 0);
  } finally {
    release();
  }
  assert.deepEqual(await first, { settled: 1, flagged: 0, failed: 0 });
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);

  const [lease] = await db.select({ heldUntil: sweepLease.heldUntil }).from(sweepLease).where(eq(sweepLease.institutionId, home.institutionId));
  assert.ok(lease.heldUntil.getTime() < Date.now(), "released when the sweep ends");
});

test("a PaymentIntent Stripe does not know is retried for a day, then flagged and left alone", async () => {
  const actor = await person();
  const [seeded] = await db
    .insert(engagement)
    .values({ institutionId: home.institutionId, studentProfileId: actor.studentProfileId, tutorCourseId, courseOfferingId: home.offeringId, kind: "exam_anchored", sessionsPurchased: 4, pricePaidMinor: 14_000 })
    .returning({ id: engagement.id });
  await db.insert(ledgerEntry).values({ engagementId: seeded.id, institutionId: home.institutionId, type: "package_purchase", amountMinor: 14_000, stripeReference: `pi_test_${seeded.id}` });
  await endPackage({ actor, engagementId: seeded.id });

  await age(seeded.id);
  assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 1 });
  assert.deepEqual(await discrepancies(seeded.id), []);

  await age(seeded.id, 25 * 3_600_000);
  assert.deepEqual(await sweep(), { settled: 0, flagged: 1, failed: 0 });
  assert.deepEqual(await discrepancies(seeded.id), [{ kind: "refund_failed", stripeReference: `pi_test_${seeded.id}`, ledgerAmountMinor: 14_000 }]);
  assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
});

test("a failed stray payment on the engagement neither blocks its package refund nor takes its manual settlement", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  const stray = `pi_stray_${run}_${engagementId.slice(0, 8)}`;
  await recordRefundFailure(ids(engagementId), { refund: null, paymentIntentId: stray, amountMinor: null, currency: "usd" });
  const [flag] = await db.select({ id: moneyDiscrepancy.id }).from(moneyDiscrepancy).where(eq(moneyDiscrepancy.engagementId, engagementId));

  await endPackage({ actor, engagementId });
  await patched("refund", lostResponse, async () => {
    await assert.rejects(refundThroughStripe(ids(engagementId)), /socket hang up/);
  });
  assert.deepEqual(await recordManualSettlement({ operator: await operator(), discrepancyId: flag.id, note: "stray paid back by Zelle" }), { ok: true });
  assert.equal((await refundRow(engagementId)).stripeReference, null, "settling the stray payment does not stamp the package's refund");

  await age(engagementId);
  assert.deepEqual(await sweep(), { settled: 1, flagged: 0, failed: 0 });
  const [refund] = await fakeStripe.refunds(checkoutSessionId);
  assert.equal((await refundRow(engagementId)).stripeReference, refund.id);
});

test("a blocked refund row is counted by the sweep, not passed over in silence", async () => {
  const before = (await retryUnstampedRefunds(home.institutionId, Date.now() + 10_000)).blocked;
  const { actor, engagementId } = await bought();
  await endPackage({ actor, engagementId });
  await patched("refund", refused, async () => {
    await refundThroughStripe(ids(engagementId));
  });
  assert.equal((await retryUnstampedRefunds(home.institutionId, Date.now() + 10_000)).blocked, before + 1);
});

test("a fresh 5xx in the sweep is left for the next pass, which moves keys only once Stripe replays it", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  await endPackage({ actor, engagementId });
  await age(engagementId);
  fakeStripe.failNextRefund();
  assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 1 });
  assert.deepEqual(await fakeStripe.refunds(checkoutSessionId), []);
  assert.deepEqual(await sweep(), { settled: 1, flagged: 0, failed: 0 });
  assert.equal((await fakeStripe.refunds(checkoutSessionId)).length, 1);
});

test("a paid PaymentIntent is never flagged on a 404, however old the row", async () => {
  const { actor, engagementId } = await bought();
  await endPackage({ actor, engagementId });
  await age(engagementId, 25 * 3_600_000);
  await patched("listRefunds", async () => { throw new GatewayError("No such payment_intent", { status: 404, code: "resource_missing" }); }, async () => {
    assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 1 });
  });
  assert.deepEqual(await discrepancies(engagementId), []);
  assert.deepEqual(await sweep(), { settled: 1, flagged: 0, failed: 0 });
});

test("a refund held behind a failed one on its PaymentIntent goes out once ops resolves, and failing reopens the flag on its row", async () => {
  const { actor, engagementId, checkoutSessionId } = await bought();
  const [paid] = await db
    .select({ pi: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "package_purchase")));
  await recordRefundFailure(ids(engagementId), { refund: null, paymentIntentId: paid.pi!, amountMinor: null, currency: "usd" });
  const flag = async () =>
    db
      .select({ id: moneyDiscrepancy.id, ledgerEntryId: moneyDiscrepancy.ledgerEntryId, resolvedAt: moneyDiscrepancy.resolvedAt, note: moneyDiscrepancy.resolutionNote })
      .from(moneyDiscrepancy)
      .where(eq(moneyDiscrepancy.engagementId, engagementId));

  await endPackage({ actor, engagementId });
  await age(engagementId);
  const blocked = await blockedRefunds(home.institutionId);
  assert.equal(await creates(async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "skipped");
    assert.deepEqual(await sweep(), { settled: 0, flagged: 0, failed: 0 });
  }), 0);

  const [open] = await flag();
  await db.update(moneyDiscrepancy).set({ resolvedAt: new Date(), resolutionNote: "card checked" }).where(eq(moneyDiscrepancy.id, open.id));
  assert.equal(await blockedRefunds(home.institutionId), blocked - 1);
  await patched("refund", refused, async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "refund_failed");
  });
  const row = await refundRow(engagementId);
  assert.deepEqual(await flag(), [{ id: open.id, ledgerEntryId: row.id, resolvedAt: null, note: null }]);

  assert.equal(await creates(async () => {
    assert.equal(await refundThroughStripe(ids(engagementId)), "skipped");
    await sweep();
  }), 0);
  assert.deepEqual(await recordManualSettlement({ operator: await operator(), discrepancyId: open.id, note: "paid by hand" }), { ok: true });
  assert.equal((await refundRow(engagementId)).stripeReference, `manual:${open.id}`);
  assert.deepEqual(await fakeStripe.refunds(checkoutSessionId), []);
});

test("money invariants hold after every refund path", async () => {
  await assertMoneyInvariants(home.institutionId);
});
