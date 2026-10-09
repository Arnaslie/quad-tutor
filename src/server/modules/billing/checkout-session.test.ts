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
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { releaseCheckout } from "@/server/modules/engagements/checkout";
import { PurchaseError, purchasePackage, slotsForRequest } from "@/server/modules/engagements/purchase";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";

import {
  cancelCheckout,
  checkoutRedirect,
  settleCheckout,
  syncCheckout,
  syncOwnCheckouts,
  syncPendingCheckouts,
} from "./checkout-session";
import { assertMoneyInvariants } from "./invariants";
import { fakeStripe, signWebhookPayload, stripeGateway } from "./stripe";
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
let home: { institutionId: string; termId: string; courseId: string; offeringId: string };
let tutor: TutorActor;
let tutorCourseId: string;

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

let people = 0;
async function person(): Promise<Actor> {
  const id = `test_checkout_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  users.push(id);
  const [profile] = await db
    .insert(studentProfile)
    .values({ userId: id, institutionId: home.institutionId })
    .returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId: home.institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

async function accepted(student: Actor): Promise<{ requestId: string; slots: Date[] }> {
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  const [request] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.status, "pending")));
  await acceptRequest({ tutor, requestId: request.id });
  return { requestId: request.id, slots: await slotsForRequest({ actor: student, requestId: request.id }) };
}

async function opened(student?: Actor) {
  const actor = student ?? (await person());
  const { requestId, slots } = await accepted(actor);
  const buy = (slot = slots[0]) => purchasePackage({ actor, requestId, anchorExamId: null, slotStartsAt: slot });
  const url = await checkoutRedirect(home.institutionId, () => buy());
  const row = await pending(actor);
  return { actor, buy, slots, url, engagementId: row.id, sessionId: row.sessionId! };
}

async function pending(actor: Actor) {
  const [row] = await db
    .select({ id: engagement.id, sessionId: engagement.stripeCheckoutSessionId })
    .from(engagement)
    .where(and(eq(engagement.studentProfileId, actor.studentProfileId), eq(engagement.status, "pending_payment")));
  return row;
}

async function state(engagementId: string) {
  const [row] = await db.select({ status: engagement.status }).from(engagement).where(eq(engagement.id, engagementId));
  const sessions = await db.select({ status: sessionBooking.status }).from(sessionBooking).where(eq(sessionBooking.engagementId, engagementId));
  const ledger = await db
    .select({ type: ledgerEntry.type, amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.engagementId, engagementId))
    .orderBy(ledgerEntry.type);
  return { status: row.status, sessions: sessions.map((session) => session.status), ledger };
}

const paidState = {
  status: "active",
  sessions: ["scheduled"],
  ledger: [
    { type: "package_purchase", amountMinor: 14_000 },
    { type: "processor_fee", amountMinor: 436 },
  ],
};

async function deliver(sessionId: string) {
  const { payload, signature } = await fakeStripe.event(sessionId);
  return handleStripeWebhook(payload, signature);
}

async function expireRow(engagementId: string) {
  await db
    .update(engagement)
    .set({ checkoutExpiresAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(eq(engagement.id, engagementId));
}

before(async () => {
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test checkout", slug: `checkout-${run}`, emailDomain: `checkout-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: inDays(-30), endsOn: inDays(60) })
    .returning({ id: term.id });
  const [courseRow] = await db.insert(course).values({ institutionId: inst.id, title: "Checkout 101", department: "TEST" }).returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `CHK ${run}` });
  const [offering] = await db
    .insert(courseOffering)
    .values({ institutionId: inst.id, courseId: courseRow.id, termId: termRow.id, section: "001" })
    .returning({ id: courseOffering.id });
  home = { institutionId: inst.id, termId: termRow.id, courseId: courseRow.id, offeringId: offering.id };

  const base = await person();
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId: inst.id }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      tutorProfileId: profile.id,
      institutionId: inst.id,
      weekday,
      startMinute: 8 * 60,
      endMinute: 20 * 60,
    })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId: inst.id, courseId: courseRow.id, takenTermId: termRow.id, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  tutor = { ...base, tutorProfileId: profile.id };
  tutorCourseId = claim.id;
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
  await db.delete(institution).where(eq(institution.id, institutionId));
  await db.$client.end();
});

test("the fake replays a create by key, refuses changed params, and keeps Stripe's expiry window", async () => {
  const gateway = stripeGateway();
  const params = {
    engagementId: randomUUID(),
    institutionId: randomUUID(),
    amountMinor: 3_500,
    currency: "usd",
    description: "fake",
    customerEmail: "a@example.test",
    expiresAt: new Date(Date.now() + 35 * 60 * 1000),
    successUrl: "http://localhost:3000/sessions",
    cancelUrl: "http://localhost:3000/checkout/cancel",
  };
  const first = await gateway.createCheckout(params);
  assert.equal((await gateway.createCheckout(params)).id, first.id);
  await assert.rejects(gateway.createCheckout({ ...params, amountMinor: 1 }), /same parameters/);
  await assert.rejects(
    gateway.createCheckout({ ...params, engagementId: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }),
    /30 minutes/,
  );

  const paid = await fakeStripe.pay(first.id);
  await assert.rejects(gateway.expireCheckout(first.id), /open/);
  assert.equal((await gateway.chargeFee(paid.paymentIntentId!))?.feeMinor, 132);
  const refund = await gateway.refund({ paymentIntentId: paid.paymentIntentId!, engagementId: params.engagementId, institutionId: params.institutionId });
  assert.deepEqual(await gateway.refund({ paymentIntentId: paid.paymentIntentId!, engagementId: params.engagementId, institutionId: params.institutionId }), refund);
  assert.deepEqual(await gateway.listRefunds(paid.paymentIntentId!), [refund]);
});

test("buy → Stripe page → signed completed event books the package once", async () => {
  const { url, engagementId, sessionId } = await opened();
  assert.equal(url, (await stripeGateway().retrieveCheckout(sessionId)).url);
  assert.match(url, /\/api\/dev\/checkout\/cs_fake_/);
  assert.deepEqual(await state(engagementId), { status: "pending_payment", sessions: ["held"], ledger: [] });

  await fakeStripe.pay(sessionId);
  assert.deepEqual(await deliver(sessionId), { status: 200, outcome: "fulfilled", institutionId: home.institutionId });
  assert.deepEqual(await deliver(sessionId), { status: 200, outcome: "settled", institutionId: home.institutionId });
  assert.deepEqual(await state(engagementId), paidState);
  assert.deepEqual(await fakeStripe.refunds(sessionId), []);
});

test("a second click resumes the same Stripe page", async () => {
  const { buy, url, sessionId } = await opened();
  assert.equal(await checkoutRedirect(home.institutionId, () => buy()), url);
  await fakeStripe.pay(sessionId);
  await syncCheckout(sessionId);
  const { engagementId } = await buy();
  assert.equal(await checkoutRedirect(home.institutionId, () => buy()), `/sessions?package=${engagementId}`);
});

test("the webhook rejects bad signatures and livemode mismatches, and ignores other events", async () => {
  const { sessionId } = await opened();
  const { payload } = await fakeStripe.event(sessionId);
  assert.deepEqual(await handleStripeWebhook(payload, null), { status: 400, reason: "bad signature" });
  assert.deepEqual(await handleStripeWebhook(payload, "t=1,v1=nope"), { status: 400, reason: "bad signature" });
  assert.deepEqual(
    await handleStripeWebhook(payload, signWebhookPayload(payload, "whsec_someone_else")),
    { status: 400, reason: "bad signature" },
  );
  assert.deepEqual(
    await handleStripeWebhook(payload, signWebhookPayload(payload).replace(/v1=./, (m) => (m.endsWith("0") ? "v1=1" : "v1=0"))),
    { status: 400, reason: "bad signature" },
  );

  const live = JSON.stringify({ ...JSON.parse(payload), livemode: true });
  assert.deepEqual(await handleStripeWebhook(live, signWebhookPayload(live)), { status: 400, reason: "livemode mismatch" });

  const other = JSON.stringify({ ...JSON.parse(payload), type: "customer.created" });
  assert.deepEqual(await handleStripeWebhook(other, signWebhookPayload(other)), { status: 200, outcome: "ignored", institutionId: null });
});

test("events are read against Stripe's current state, so a late expired event cannot undo a payment", async () => {
  const { engagementId, sessionId } = await opened();
  const { payload: stale } = await fakeStripe.event(sessionId);
  const expired = JSON.stringify({ ...JSON.parse(stale), type: "checkout.session.expired" });

  await fakeStripe.pay(sessionId);
  assert.equal((await handleStripeWebhook(expired, signWebhookPayload(expired))).status, 200);
  assert.deepEqual(await state(engagementId), paidState, "the expired event found the Session complete and fulfilled");
  assert.equal((await deliver(sessionId)).status, 200);
  assert.deepEqual(await state(engagementId), paidState);
});

test("an expired Session releases the hold, and a completed event for it afterwards changes nothing", async () => {
  const { engagementId, sessionId } = await opened();
  await stripeGateway().expireCheckout(sessionId);
  assert.equal((await deliver(sessionId)).status, 200);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });

  const { payload } = await fakeStripe.event(sessionId);
  const completed = JSON.stringify({ ...JSON.parse(payload), type: "checkout.session.completed" });
  assert.deepEqual(await handleStripeWebhook(completed, signWebhookPayload(completed)), { status: 200, outcome: "settled", institutionId: home.institutionId });
  assert.deepEqual(await fakeStripe.refunds(sessionId), []);
});

test("money taken after the hold was released is refunded once, with no ledger row", async () => {
  const { engagementId, sessionId } = await opened();
  await fakeStripe.pay(sessionId);
  await releaseCheckout({ engagementId, institutionId: home.institutionId, checkoutSessionId: sessionId });

  assert.equal((await syncCheckout(sessionId)).outcome, "refunded");
  assert.equal((await syncCheckout(sessionId)).outcome, "refunded");
  assert.equal((await fakeStripe.refunds(sessionId)).length, 1);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
});

test("a payment on a Session the engagement no longer carries is refunded", async () => {
  const { engagementId, sessionId } = await opened();
  await fakeStripe.pay(sessionId);
  await db.update(engagement).set({ stripeCheckoutSessionId: `cs_${run}_other` }).where(eq(engagement.id, engagementId));

  assert.equal((await syncCheckout(sessionId)).outcome, "refunded");
  assert.equal((await fakeStripe.refunds(sessionId)).length, 1);
  assert.deepEqual(await state(engagementId), { status: "pending_payment", sessions: ["held"], ledger: [] });
  await db.update(engagement).set({ stripeCheckoutSessionId: sessionId }).where(eq(engagement.id, engagementId));
  await releaseCheckout({ engagementId, institutionId: home.institutionId, checkoutSessionId: sessionId });
});

test("an amount mismatch refunds and stamps the discrepancy", async () => {
  const { engagementId, sessionId } = await opened();
  await fakeStripe.pay(sessionId, { amountTotal: 100 });

  assert.equal((await syncCheckout(sessionId)).outcome, "refunded");
  assert.equal((await syncCheckout(sessionId)).outcome, "refunded");
  const refunds = await fakeStripe.refunds(sessionId);
  assert.equal(refunds.length, 1);
  const [discrepancy] = await db
    .select({ refundReference: moneyDiscrepancy.refundReference })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.engagementId, engagementId));
  assert.equal(discrepancy.refundReference, refunds[0].id);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
});

test("a payment whose charge is already in the ledger releases the hold and is refunded", async () => {
  const first = await opened();
  await fakeStripe.pay(first.sessionId);
  await syncCheckout(first.sessionId);

  const { engagementId, sessionId } = await opened();
  const { paymentIntentId } = await fakeStripe.pay(sessionId);
  const fee = await stripeGateway().chargeFee(paymentIntentId!);
  const [clash] = await db
    .insert(ledgerEntry)
    .values({ engagementId: first.engagementId, institutionId: home.institutionId, type: "processor_fee", amountMinor: 0, stripeReference: fee!.balanceTransactionId })
    .returning({ id: ledgerEntry.id });

  assert.equal((await syncCheckout(sessionId)).outcome, "refunded");
  assert.equal((await fakeStripe.refunds(sessionId)).length, 1);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
  await db.delete(ledgerEntry).where(eq(ledgerEntry.id, clash.id));
});

test("the sweep expires open Sessions past the hold and releases them", async () => {
  const { engagementId, sessionId } = await opened();
  await expireRow(engagementId);
  const swept = await syncPendingCheckouts(home.institutionId);
  assert.equal(swept.failed, 0);
  assert.equal((await stripeGateway().retrieveCheckout(sessionId)).status, "expired");
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
});

test("the sweep fulfils a paid Session whose event never came", async () => {
  const { engagementId, sessionId } = await opened();
  await fakeStripe.pay(sessionId);
  await expireRow(engagementId);
  await syncPendingCheckouts(home.institutionId);
  assert.deepEqual(await state(engagementId), paidState);
});

test("when expire loses a race with a payment, the sweep fulfils instead of releasing", async () => {
  const { engagementId } = await opened();
  await expireRow(engagementId);
  const gateway = stripeGateway();
  const expire = gateway.expireCheckout;
  gateway.expireCheckout = async (id) => {
    await fakeStripe.pay(id);
    return expire(id);
  };
  try {
    await syncPendingCheckouts(home.institutionId);
  } finally {
    gateway.expireCheckout = expire;
  }
  assert.deepEqual(await state(engagementId), paidState);
});

test("an unstamped row recovers its Session by replaying create, then expires and releases it", async () => {
  const { engagementId, sessionId } = await opened();
  await db.update(engagement).set({ stripeCheckoutSessionId: null }).where(eq(engagement.id, engagementId));

  assert.equal(await settleCheckout({ engagementId, institutionId: home.institutionId, sessionId: null }), "released");
  assert.equal((await stripeGateway().retrieveCheckout(sessionId)).status, "expired");
  const [row] = await db.select({ sessionId: engagement.stripeCheckoutSessionId }).from(engagement).where(eq(engagement.id, engagementId));
  assert.equal(row.sessionId, sessionId);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
});

test("an unstamped row with no Session to recover is released at once", async () => {
  const actor = await person();
  const { requestId, slots } = await accepted(actor);
  const { engagementId } = await purchasePackage({ actor, requestId, anchorExamId: null, slotStartsAt: slots[0] });
  await expireRow(engagementId);
  await syncPendingCheckouts(home.institutionId);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
});

test("a different choice expires the open checkout and opens a new one", async () => {
  const { actor, buy, slots, engagementId, sessionId } = await opened();
  const url = await checkoutRedirect(home.institutionId, () => buy(slots[1]));
  const fresh = await pending(actor);
  assert.notEqual(fresh.id, engagementId);
  assert.equal(url, (await stripeGateway().retrieveCheckout(fresh.sessionId!)).url);
  assert.equal((await stripeGateway().retrieveCheckout(sessionId)).status, "expired");
  assert.equal((await state(engagementId)).status, "cancelled");
});

test("an expired or nearly expired hold is settled and bought fresh", async () => {
  const { actor, buy, engagementId } = await opened();
  await expireRow(engagementId);
  await checkoutRedirect(home.institutionId, () => buy());
  const fresh = await pending(actor);
  assert.notEqual(fresh.id, engagementId);
  assert.equal((await state(engagementId)).status, "cancelled");

  await db.update(engagement).set({ checkoutExpiresAt: new Date(Date.now() + 60_000) }).where(eq(engagement.id, fresh.id));
  await checkoutRedirect(home.institutionId, () => buy());
  assert.notEqual((await pending(actor)).id, fresh.id);
  assert.equal((await state(fresh.id)).status, "cancelled");
});

test("a Session that loses the stamp is expired and never redirected to", async () => {
  const actor = await person();
  const { requestId, slots } = await accepted(actor);
  const gateway = stripeGateway();
  const create = gateway.createCheckout;
  let created: string | null = null;
  gateway.createCheckout = async (params) => {
    const session = await create(params);
    created = session.id;
    await db.update(engagement).set({ stripeCheckoutSessionId: `cs_${run}_raced` }).where(eq(engagement.id, params.engagementId));
    return session;
  };
  try {
    await assert.rejects(
      checkoutRedirect(home.institutionId, () => purchasePackage({ actor, requestId, anchorExamId: null, slotStartsAt: slots[0] })),
      PurchaseError,
    );
  } finally {
    gateway.createCheckout = create;
  }
  assert.equal((await gateway.retrieveCheckout(created!)).status, "expired");
  const row = await pending(actor);
  await db.update(engagement).set({ stripeCheckoutSessionId: null }).where(eq(engagement.id, row.id));
  await releaseCheckout({ engagementId: row.id, institutionId: home.institutionId, checkoutSessionId: null });
});

test("cancel and reads only touch the viewer's own checkouts", async () => {
  const mine = await opened();
  const theirs = await opened();

  assert.equal(await cancelCheckout(mine.actor, theirs.engagementId), null);
  assert.equal((await state(theirs.engagementId)).status, "pending_payment");

  await fakeStripe.pay(theirs.sessionId);
  assert.equal(await syncOwnCheckouts(mine.actor), false);
  assert.equal((await state(theirs.engagementId)).status, "pending_payment");
  assert.equal(await syncOwnCheckouts(theirs.actor), true);
  assert.deepEqual(await state(theirs.engagementId), paidState);

  assert.deepEqual(await cancelCheckout(mine.actor, mine.engagementId), { status: "cancelled", kind: "exam_anchored" });
  assert.equal((await stripeGateway().retrieveCheckout(mine.sessionId)).status, "expired");
});

test("money invariants hold after every checkout path", async () => {
  await assertMoneyInvariants(home.institutionId);
});
