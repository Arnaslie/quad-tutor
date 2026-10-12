import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

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
  paymentDispute,
  reliabilityEvent,
  sessionBooking,
  studentProfile,
  sweepLease,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { confirmAttendance } from "@/server/modules/engagements/confirmation";
import { purchasePackage, slotsForRequest } from "@/server/modules/engagements/purchase";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { checkoutRedirect, syncCheckout } from "./checkout-session";
import { ensureConnectAccount, syncConnectAccount } from "./connect";
import { assertMoneyInvariants } from "./invariants";
import { GatewayError, fakeStripe, stripeGateway, type Gateway } from "./stripe";
import { runTransfers } from "./transfers";
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
const campuses: string[] = [];

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const nothing = { sent: 0, settled: 0, waiting: 0, flagged: 0, blocked: 0, failed: 0 };

type World = { institutionId: string; offeringId: string; termId: string; tutor: TutorActor; tutorCourseId: string; accountId: string };

let people = 0;
async function person(institutionId: string): Promise<Actor> {
  const id = `test_transfer_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  users.push(id);
  const [profile] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

/** A campus of its own per test, so counts and the lease never mix, with a tutor Stripe has verified. */
async function world(): Promise<World> {
  const slug = `transfers-${run}-${campuses.length}`;
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test transfers", slug, emailDomain: `${slug}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  campuses.push(inst.id);
  const [now] = await db.insert(term).values({ institutionId: inst.id, name: "Now", startsOn: inDays(-30), endsOn: inDays(60) }).returning({ id: term.id });
  const [courseRow] = await db.insert(course).values({ institutionId: inst.id, title: "Transfers 101", department: "TEST" }).returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `TRF ${slug}` });
  const [offering] = await db.insert(courseOffering).values({ institutionId: inst.id, courseId: courseRow.id, termId: now.id, section: "001" }).returning({ id: courseOffering.id });

  const base = await person(inst.id);
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId: inst.id }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tutorProfileId: profile.id, institutionId: inst.id, weekday, startMinute: 8 * 60, endMinute: 20 * 60 })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId: inst.id, courseId: courseRow.id, takenTermId: now.id, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  const tutor = { ...base, tutorProfileId: profile.id };
  const accountId = await ensureConnectAccount(tutor);
  await fakeStripe.setAccount(accountId, "verified");
  assert.equal((await syncConnectAccount(accountId)).outcome, "kyc_synced");
  return { institutionId: inst.id, offeringId: offering.id, termId: now.id, tutor, tutorCourseId: claim.id, accountId };
}

/** A four-pack paid through the fake, its first session confirmed by both sides so `recognise()` accrues it. */
async function delivered(w: World) {
  const actor = await person(w.institutionId);
  await requestTutors({ actor, courseOfferingId: w.offeringId, tutorCourseIds: [w.tutorCourseId], kind: "exam_anchored" });
  const [request] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, actor.studentProfileId), eq(matchRequest.status, "pending")));
  await acceptRequest({ tutor: w.tutor, requestId: request.id });
  const [slot] = await slotsForRequest({ actor, requestId: request.id });
  await checkoutRedirect(w.institutionId, () => purchasePackage({ actor, requestId: request.id, anchorExamId: null, slotStartsAt: slot }));
  const [row] = await db
    .select({ id: engagement.id, sessionId: engagement.stripeCheckoutSessionId })
    .from(engagement)
    .where(and(eq(engagement.studentProfileId, actor.studentProfileId), eq(engagement.status, "pending_payment")));
  await fakeStripe.pay(row.sessionId!);
  assert.equal((await syncCheckout(row.sessionId!)).outcome, "fulfilled");

  const [session] = await db.select({ id: sessionBooking.id }).from(sessionBooking).where(eq(sessionBooking.engagementId, row.id));
  await db.update(sessionBooking).set({ scheduledAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(sessionBooking.id, session.id));
  await confirmAttendance({ actor, sessionId: session.id });
  assert.equal((await confirmAttendance({ actor: w.tutor, sessionId: session.id })).status, "completed");

  const [paid] = await db
    .select({ pi: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, row.id), eq(ledgerEntry.type, "package_purchase")));
  return { actor, engagementId: row.id, paymentIntentId: paid.pi! };
}

async function rows(engagementId: string, type: "tutor_transfer" | "transfer_reversal" | "tutor_accrued") {
  return db
    .select({ id: ledgerEntry.id, amountMinor: ledgerEntry.amountMinor, stripeReference: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, type)));
}

async function discrepancies(engagementId: string) {
  return db
    .select({ kind: moneyDiscrepancy.kind, ledgerEntryId: moneyDiscrepancy.ledgerEntryId, ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor, stripeAmountMinor: moneyDiscrepancy.stripeAmountMinor })
    .from(moneyDiscrepancy)
    .where(eq(moneyDiscrepancy.engagementId, engagementId));
}

/** Puts the transfer rows past the sweep's grace, as if the after-commit call died a while ago. */
async function age(engagementId: string) {
  await db
    .update(ledgerEntry)
    .set({ occurredAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "tutor_transfer")));
}

const sweep = (w: World) => runTransfers(w.institutionId, Date.now() + 10_000);

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

async function deliver(event: { payload: string; signature: string }) {
  return handleStripeWebhook(event.payload, event.signature);
}

after(async () => {
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.institutionId, campuses))).map((row) => row.id);
  if (engagements.length) {
    await db.delete(paymentDispute).where(inArray(paymentDispute.engagementId, engagements));
    await db.delete(moneyDiscrepancy).where(inArray(moneyDiscrepancy.engagementId, engagements));
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(reliabilityEvent).where(inArray(reliabilityEvent.institutionId, campuses));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
  await db.delete(matchRequest).where(inArray(matchRequest.institutionId, campuses));
  await db.delete(messageThread).where(inArray(messageThread.institutionId, campuses));
  await db.delete(tutorAvailability).where(inArray(tutorAvailability.institutionId, campuses));
  await db.delete(tutorCourse).where(inArray(tutorCourse.institutionId, campuses));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, users));
  await db.delete(user).where(inArray(user.id, users));
  await db.delete(courseOffering).where(inArray(courseOffering.institutionId, campuses));
  await db.delete(courseCodeAlias).where(inArray(courseCodeAlias.institutionId, campuses));
  await db.delete(course).where(inArray(course.institutionId, campuses));
  await db.delete(term).where(inArray(term.institutionId, campuses));
  await db.delete(sweepLease).where(inArray(sweepLease.institutionId, campuses));
  await db.delete(institution).where(inArray(institution.id, campuses));
  await db.$client.end();
});

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
  });
  assert.deepEqual(await earningsForTutor(w.tutor), { earnedMinor: 3_150, owedMinor: 0, transferredMinor: 3_150, currency: "usd", sessionsDelivered: 1 });

  assert.deepEqual(await creates(async () => {
    assert.deepEqual(await sweep(w), nothing);
  }), []);
  assert.equal((await stripeGateway().listTransfers(engagementId)).length, 1);
});

test("past the term's fee cap the tutor is sent the full session price", async () => {
  const w = await world();
  const { engagementId } = await delivered(w);
  await db.insert(ledgerEntry).values({ engagementId, institutionId: w.institutionId, type: "platform_fee", amountMinor: 10_000 - 350 });

  const { engagementId: capped } = await delivered(w);
  assert.deepEqual((await rows(capped, "tutor_accrued")).map((r) => r.amountMinor), [3_500]);
  assert.deepEqual(await sweep(w), { ...nothing, sent: 2 });
  assert.deepEqual((await rows(capped, "tutor_transfer")).map((r) => r.amountMinor), [3_500]);
  assert.deepEqual((await rows(engagementId, "tutor_transfer")).map((r) => r.amountMinor), [3_150]);
  const [sent] = await rows(capped, "tutor_transfer");
  assert.equal((await stripeGateway().retrieveTransfer(sent.stripeReference!)).amountMinor, 3_500);
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
  const row = { engagementId: legacy.id, institutionId: w.institutionId };
  await db.insert(ledgerEntry).values([
    { ...row, type: "package_purchase", amountMinor: 14_000 },
    { ...row, type: "session_earned", amountMinor: 3_500 },
    { ...row, type: "tutor_accrued", amountMinor: 3_150 },
    { ...row, type: "platform_fee", amountMinor: 350 },
  ]);

  const gateway = stripeGateway();
  const methods = Object.keys(gateway).filter((key) => typeof gateway[key as keyof Gateway] === "function") as (keyof Gateway)[];
  const originals = new Map(methods.map((name) => [name, gateway[name]]));
  for (const name of methods) Object.assign(gateway, { [name]: async () => { throw new Error(`no Stripe call: ${name}`); } });
  try {
    assert.deepEqual(await sweep(w), nothing);
  } finally {
    for (const [name, original] of originals) Object.assign(gateway, { [name]: original });
  }
  assert.deepEqual(await rows(legacy.id, "tutor_transfer"), []);
});

test("money invariants hold on every campus after every transfer path", async () => {
  for (const institutionId of campuses) await assertMoneyInvariants(institutionId);
});
