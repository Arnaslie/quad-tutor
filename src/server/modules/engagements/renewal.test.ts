import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { and, eq, inArray, sql } from "drizzle-orm";

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
  reliabilityEvent,
  sessionBooking,
  studentProfile,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
  userBlock,
} from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import {
  RequestError,
  acceptRequest,
  inboxForTutor,
  requestRenewal,
  requestTutors,
  requestsForStudent,
} from "@/server/modules/matching/requests";
import { requestWaiting } from "@/server/modules/notifications/messages";

import { assertMoneyInvariants } from "@/server/modules/billing/invariants";

import { SessionError } from "./access";
import { buyPackage, buyTopUp, pay } from "./buy-and-pay";
import { fulfilCheckout, releaseCheckout, type FulfilResult } from "./checkout";
import { confirmAttendance } from "./confirmation";
import {
  PurchaseError,
  type Checkout,
  type PurchaseResult,
  purchasePackage,
  purchaseTopUp,
  slotsForRequest,
  slotsForTopUp,
} from "./purchase";
import { bookAgain, bookAgainList, sessionBoardForStudent, sessionBoardForTutor } from "./reads";
import { bookSession, slotsForEngagement } from "./scheduling";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

let home: { institutionId: string; termId: string; courseId: string; offeringId: string };
let tutor: TutorActor;
let otherTutor: TutorActor;
let tutorCourseId: string;
let otherTutorCourseId: string;

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

let people = 0;
async function person(institutionId: string): Promise<Actor> {
  const id = `test_renewal_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

async function tutorWithClaim(): Promise<{ actor: TutorActor; claimId: string }> {
  const base = await person(home.institutionId);
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId: home.institutionId }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      tutorProfileId: profile.id,
      institutionId: home.institutionId,
      weekday,
      startMinute: 8 * 60,
      endMinute: 20 * 60,
    })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId: home.institutionId, courseId: home.courseId, takenTermId: home.termId, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  return { actor: { ...base, tutorProfileId: profile.id }, claimId: claim.id };
}

async function pendingRequest(student: Actor, claimId: string): Promise<string> {
  const [row] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.tutorCourseId, claimId), eq(matchRequest.status, "pending")));
  return row.id;
}

async function acceptedRequest(student: Actor): Promise<string> {
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  const requestId = await pendingRequest(student, tutorCourseId);
  await acceptRequest({ tutor, requestId });
  return requestId;
}

async function boughtPackage(student: Actor): Promise<string> {
  const requestId = await acceptedRequest(student);
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const { engagementId } = await buyPackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  return engagementId;
}

async function finishedPair(): Promise<{ student: Actor; engagementId: string }> {
  const student = await person(home.institutionId);
  const engagementId = await boughtPackage(student);
  await db.update(engagement).set({ sessionsPurchased: 1 }).where(eq(engagement.id, engagementId));
  return { student, engagementId };
}

async function state(engagementId: string) {
  const [row] = await db.select({ status: engagement.status }).from(engagement).where(eq(engagement.id, engagementId));
  const sessions = await db.select({ status: sessionBooking.status }).from(sessionBooking).where(eq(sessionBooking.engagementId, engagementId));
  const ledger = await db
    .select({ type: ledgerEntry.type, amountMinor: ledgerEntry.amountMinor, stripeReference: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.engagementId, engagementId))
    .orderBy(ledgerEntry.type);
  return { status: row.status, sessions: sessions.map((session) => session.status), ledger };
}

const onBoard = (board: Awaited<ReturnType<typeof sessionBoardForStudent>>, engagementId: string) =>
  [...board.awaitingAnswer, ...board.upcoming, ...board.past].filter((item) => item.engagementId === engagementId);

async function topUps(student: Actor): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(engagement)
    .where(and(eq(engagement.studentProfileId, student.studentProfileId), eq(engagement.kind, "top_up")));
  return row.n;
}

before(async () => {
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test renewal", slug: `renewal-${run}`, emailDomain: `renewal-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);
  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: inDays(-30), endsOn: inDays(60) })
    .returning({ id: term.id });
  const [courseRow] = await db.insert(course).values({ institutionId: inst.id, title: "Renewal 101", department: "TEST" }).returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `REN ${run}` });
  const [offering] = await db
    .insert(courseOffering)
    .values({ institutionId: inst.id, courseId: courseRow.id, termId: termRow.id, section: "001" })
    .returning({ id: courseOffering.id });
  home = { institutionId: inst.id, termId: termRow.id, courseId: courseRow.id, offeringId: offering.id };

  ({ actor: tutor, claimId: tutorCourseId } = await tutorWithClaim());
  ({ actor: otherTutor, claimId: otherTutorCourseId } = await tutorWithClaim());
});

after(async () => {
  const institutions = made.institutions;
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.institutionId, institutions))).map((row) => row.id);
  if (engagements.length) {
    await db.delete(moneyDiscrepancy).where(inArray(moneyDiscrepancy.engagementId, engagements));
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
  await db.delete(matchRequest).where(inArray(matchRequest.institutionId, institutions));
  await db.delete(messageThread).where(inArray(messageThread.institutionId, institutions));
  await db.delete(userBlock).where(inArray(userBlock.institutionId, institutions));
  await db.delete(tutorAvailability).where(inArray(tutorAvailability.institutionId, institutions));
  await db.delete(tutorCourse).where(inArray(tutorCourse.institutionId, institutions));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, made.users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, made.users));
  await db.delete(user).where(inArray(user.id, made.users));
  await db.delete(courseOffering).where(inArray(courseOffering.institutionId, institutions));
  await db.delete(courseCodeAlias).where(inArray(courseCodeAlias.institutionId, institutions));
  await db.delete(course).where(inArray(course.institutionId, institutions));
  await db.delete(term).where(inArray(term.institutionId, institutions));
  await db.delete(institution).where(inArray(institution.id, institutions));
  await db.$client.end();
});

test("a student who never worked with the tutor gets no book again and no refill", async () => {
  const cold = await person(home.institutionId);
  assert.equal(await bookAgain(cold, tutorCourseId), null);
  await assert.rejects(slotsForTopUp({ actor: cold, tutorCourseId }), PurchaseError);
  const [slot] = await slotsForTopUp({ actor: (await finishedPair()).student, tutorCourseId });
  await assert.rejects(purchaseTopUp({ actor: cold, tutorCourseId, slotStartsAt: slot }), PurchaseError);
  await assert.rejects(requestRenewal({ actor: cold, tutorCourseId, kind: "through_final" }), RequestError);
  assert.equal(await topUps(cold), 0);
});

test("book again opens mid-term once the pair's packages have nothing left to book", async () => {
  const student = await person(home.institutionId);
  const engagementId = await boughtPackage(student);
  assert.equal(await bookAgain(student, tutorCourseId), null, "three sessions still to book");

  await db.update(engagement).set({ sessionsPurchased: 1 }).where(eq(engagement.id, engagementId));
  const gate = await bookAgain(student, tutorCourseId);
  assert.ok(gate);
  assert.equal(gate.offeringId, home.offeringId);
  assert.equal(gate.liveRequest, null);
  assert.equal((await bookAgainList(student)).length, 1, "one row per pair");

  const [extra] = await db
    .insert(engagement)
    .values({ studentProfileId: student.studentProfileId, institutionId: home.institutionId, tutorCourseId, courseOfferingId: home.offeringId, kind: "through_final", sessionsPurchased: 8, pricePaidMinor: 25_200 })
    .returning({ id: engagement.id });
  assert.equal(await bookAgain(student, tutorCourseId), null, "summed over the pair, a newer package with sessions left keeps it shut");
  assert.equal((await bookAgainList(student)).length, 0);
  await db.delete(engagement).where(eq(engagement.id, extra.id));
});

test("a blocked pair and a claim that is no longer active get neither a renewal nor a refill", async () => {
  const { student } = await finishedPair();
  const [slot] = await slotsForTopUp({ actor: student, tutorCourseId });

  await db.insert(userBlock).values({ blockerUserId: student.userId, blockedUserId: tutor.userId, institutionId: home.institutionId });
  assert.equal(await bookAgain(student, tutorCourseId), null);
  await assert.rejects(purchaseTopUp({ actor: student, tutorCourseId, slotStartsAt: slot }), PurchaseError);
  await assert.rejects(requestRenewal({ actor: student, tutorCourseId, kind: "through_final" }), RequestError);
  await db.delete(userBlock).where(eq(userBlock.blockerUserId, student.userId));

  await db.update(tutorCourse).set({ status: "winding_down" }).where(eq(tutorCourse.id, tutorCourseId));
  try {
    assert.equal(await bookAgain(student, tutorCourseId), null);
    await assert.rejects(purchaseTopUp({ actor: student, tutorCourseId, slotStartsAt: slot }), PurchaseError);
  } finally {
    await db.update(tutorCourse).set({ status: "active" }).where(eq(tutorCourse.id, tutorCourseId));
  }
  assert.equal(await topUps(student), 0);
});

test("a renewal is an ordinary request naming its package, and a second ask is refused while it is out", async () => {
  const { student } = await finishedPair();
  const before = Date.now();
  assert.equal((await requestRenewal({ actor: student, tutorCourseId, kind: "through_final" })).created, 1);

  const [row] = await db
    .select({ status: matchRequest.status, requestedKind: matchRequest.requestedKind, expiresAt: matchRequest.expiresAt, institutionId: matchRequest.institutionId })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.status, "pending")));
  assert.equal(row.requestedKind, "through_final");
  assert.equal(row.institutionId, home.institutionId);
  assert.ok(Math.abs(row.expiresAt.getTime() - before - 12 * 3_600_000) < 60_000, "12h expiry");

  assert.equal((await bookAgain(student, tutorCourseId))?.liveRequest?.status, "pending");
  await assert.rejects(requestRenewal({ actor: student, tutorCourseId, kind: "exam_anchored" }), RequestError);

  const inbox = (await inboxForTutor(tutor)).filter((item) => item.studentName === student.name);
  assert.deepEqual(inbox.map((item) => item.requestedKind), ["through_final"]);
  assert.equal((await requestsForStudent(student))[0].requestedKind, "through_final");
});

test("two renewal asks at once write one request", async () => {
  const { student } = await finishedPair();
  const results = await Promise.allSettled([
    requestRenewal({ actor: student, tutorCourseId, kind: "through_final" }),
    requestRenewal({ actor: student, tutorCourseId, kind: "through_final" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.status, "pending")));
  assert.equal(n, 1);
});

test("a pair that bought can renew and be accepted, and checkout buys exactly the requested package", async () => {
  const { student } = await finishedPair();
  await requestRenewal({ actor: student, tutorCourseId, kind: "through_final" });
  const requestId = await pendingRequest(student, tutorCourseId);
  await acceptRequest({ tutor, requestId });
  assert.equal((await bookAgain(student, tutorCourseId))?.liveRequest?.status, "accepted");
  await assert.rejects(requestRenewal({ actor: student, tutorCourseId, kind: "exam_anchored" }), RequestError);

  const [slot] = await slotsForRequest({ actor: student, requestId });
  await assert.rejects(
    purchasePackage({ actor: student, requestId, kind: "exam_anchored", anchorExamId: null, slotStartsAt: slot }),
    PurchaseError,
    "a request for 8 cannot be bought as 4",
  );
  const { engagementId } = await buyPackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  const [bought] = await db
    .select({ kind: engagement.kind, sessionsPurchased: engagement.sessionsPurchased, pricePaidMinor: engagement.pricePaidMinor })
    .from(engagement)
    .where(eq(engagement.id, engagementId));
  assert.deepEqual(bought, { kind: "through_final", sessionsPurchased: 8, pricePaidMinor: 25_200 });
  assert.equal(await bookAgain(student, tutorCourseId), null, "seven sessions left to book");
});

test("a second tutor still cannot accept while another accept is unbought", async () => {
  const student = await person(home.institutionId);
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  await acceptRequest({ tutor, requestId: await pendingRequest(student, tutorCourseId) });
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [otherTutorCourseId], kind: "exam_anchored" });
  await assert.rejects(
    acceptRequest({ tutor: otherTutor, requestId: await pendingRequest(student, otherTutorCourseId) }),
    /accepted this one first/,
  );
});

test("a renewal counts against the parallel-ask limit", async () => {
  const { student } = await finishedPair();
  const expiresAt = new Date(Date.now() + 3_600_000);
  await db.insert(matchRequest).values(
    [1, 2, 3].map(() => ({ institutionId: home.institutionId, studentProfileId: student.studentProfileId, tutorCourseId: otherTutorCourseId, courseOfferingId: home.offeringId, requestedKind: "exam_anchored" as const, expiresAt })),
  );
  await assert.rejects(requestRenewal({ actor: student, tutorCourseId, kind: "through_final" }), /requests out/);
});

test("a request made before the package column keeps the free pick at checkout", async () => {
  const student = await person(home.institutionId);
  const [legacy] = await db
    .insert(matchRequest)
    .values({ institutionId: home.institutionId, studentProfileId: student.studentProfileId, tutorCourseId, courseOfferingId: home.offeringId, status: "accepted", expiresAt: new Date(Date.now() + 3_600_000) })
    .returning({ id: matchRequest.id });
  const [slot] = await slotsForRequest({ actor: student, requestId: legacy.id });
  await assert.rejects(purchasePackage({ actor: student, requestId: legacy.id, anchorExamId: null, slotStartsAt: slot }), PurchaseError);
  const { engagementId } = await buyPackage({ actor: student, requestId: legacy.id, kind: "through_final", anchorExamId: null, slotStartsAt: slot });
  const [bought] = await db.select({ kind: engagement.kind }).from(engagement).where(eq(engagement.id, engagementId));
  assert.equal(bought.kind, "through_final");
});

test("no package, refill or booking accepts a time the tutor did not publish or already gave away", async () => {
  const offHours = new Date(Date.now() + 3 * 86_400_000);
  offHours.setHours(3, 0, 0, 0);

  const student = await person(home.institutionId);
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  const requestId = await pendingRequest(student, tutorCourseId);
  await acceptRequest({ tutor, requestId });
  await assert.rejects(purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: offHours }), /no longer available/);

  const [slot, next] = await slotsForRequest({ actor: student, requestId });
  const { engagementId } = await buyPackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  await assert.rejects(bookSession({ actor: student, engagementId, slotStartsAt: offHours }), SessionError);
  await assert.rejects(bookSession({ actor: student, engagementId, slotStartsAt: slot }), SessionError, "already taken");
  await bookSession({ actor: student, engagementId, slotStartsAt: next });

  const { student: refiller } = await finishedPair();
  await assert.rejects(purchaseTopUp({ actor: refiller, tutorCourseId, slotStartsAt: offHours }), PurchaseError);
  await assert.rejects(purchaseTopUp({ actor: refiller, tutorCourseId, slotStartsAt: slot }), PurchaseError);
  assert.equal(await topUps(refiller), 0);
});

function opened(result: PurchaseResult): Checkout {
  assert.equal(result.outcome, "checkout");
  return (result as Extract<PurchaseResult, { outcome: "checkout" }>).checkout;
}

const cs = (engagementId: string) => `cs_test_${engagementId}`;

test("a double-submitted refill resumes one checkout, and paying it writes one deferred ledger row", async () => {
  const { student } = await finishedPair();
  const [slot] = await slotsForTopUp({ actor: student, tutorCourseId });

  const [first, second] = await Promise.all([
    purchaseTopUp({ actor: student, tutorCourseId, slotStartsAt: slot }),
    purchaseTopUp({ actor: student, tutorCourseId, slotStartsAt: slot }),
  ]);
  assert.deepEqual(second, first);
  assert.equal(opened(first).amountMinor, 3_500);
  assert.equal(await topUps(student), 1);
  assert.ok(await bookAgain(student, tutorCourseId), "a pending refill leaves nothing to book, so refills chain");

  const { engagementId } = await pay(first);
  assert.deepEqual(await state(engagementId), {
    status: "active",
    sessions: ["scheduled"],
    ledger: [{ type: "package_purchase", amountMinor: 3_500, stripeReference: `pi_test_${engagementId}` }],
  });
  const facts = await db.select({ id: reliabilityEvent.id }).from(reliabilityEvent).where(eq(reliabilityEvent.userId, student.userId));
  assert.equal(facts.length, 0);

  assert.ok(await bookAgain(student, tutorCourseId), "a booked refill leaves nothing to book, so refills chain");
});

test("a package checkout holds the slot and writes no ledger row until a payment fulfils it", async () => {
  const student = await person(home.institutionId);
  const requestId = await acceptedRequest(student);
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const params = { actor: student, requestId, anchorExamId: null, slotStartsAt: slot };

  const first = await purchasePackage(params);
  const { engagementId } = first;
  const checkout = opened(first);
  assert.equal(checkout.amountMinor, 14_000);
  assert.equal(checkout.currency, "usd");
  assert.equal(checkout.institutionId, home.institutionId);
  assert.match(checkout.description, new RegExp(`^REN ${run} with .+: 4 sessions`));
  assert.ok(checkout.expiresAt.getTime() > Date.now() + 34 * 60_000, "Stripe needs 30 minutes from create");
  assert.deepEqual(await purchasePackage(params), first, "a second click resumes the same checkout");

  assert.deepEqual(await state(engagementId), { status: "pending_payment", sessions: ["held"], ledger: [] });
  assert.ok(!(await slotsForRequest({ actor: student, requestId })).some((open) => open.getTime() === slot.getTime()));
  assert.equal((await requestsForStudent(student)).find((row) => row.id === requestId)?.engagementId, null);
  assert.deepEqual(onBoard(await sessionBoardForTutor(tutor), engagementId), []);
  assert.deepEqual(onBoard(await sessionBoardForStudent(student), engagementId).map((item) => item.status), ["held"]);
  const [held] = await db.select({ id: sessionBooking.id }).from(sessionBooking).where(eq(sessionBooking.engagementId, engagementId));
  await assert.rejects(confirmAttendance({ actor: student, sessionId: held.id }), /payment/);

  const ids = { engagementId, institutionId: home.institutionId, checkoutSessionId: cs(engagementId) };
  const payment = { paymentIntentId: `pi_${run}_pkg`, amountTotal: 14_000, currency: "USD", chargeFeeMinor: 436, balanceTransactionId: `txn_${run}_pkg` };
  assert.deepEqual(await fulfilCheckout({ ...ids, institutionId: randomUUID(), payment }), { outcome: "missing" });
  assert.deepEqual(await fulfilCheckout({ ...ids, payment }), { outcome: "fulfilled" });
  assert.deepEqual(await fulfilCheckout({ ...ids, payment }), { outcome: "not_pending", status: "active" });
  assert.deepEqual(await releaseCheckout(ids), { outcome: "not_pending", status: "active" });

  const [stamped] = await db.select({ id: engagement.stripeCheckoutSessionId }).from(engagement).where(eq(engagement.id, engagementId));
  assert.equal(stamped.id, cs(engagementId), "an unstamped checkout takes the paying session's id");
  assert.deepEqual(await state(engagementId), {
    status: "active",
    sessions: ["scheduled"],
    ledger: [
      { type: "package_purchase", amountMinor: 14_000, stripeReference: `pi_${run}_pkg` },
      { type: "processor_fee", amountMinor: 436, stripeReference: `txn_${run}_pkg` },
    ],
  });
  assert.deepEqual(await purchasePackage(params), { outcome: "paid", engagementId });
  assert.ok((await requestsForStudent(student)).find((row) => row.id === requestId)?.engagementId);
  assert.equal(onBoard(await sessionBoardForTutor(tutor), engagementId).length, 1);
});

test("only the checkout session stamped on the row can fulfil or release it", async () => {
  const student = await person(home.institutionId);
  const requestId = await acceptedRequest(student);
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const { engagementId } = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  const ids = { engagementId, institutionId: home.institutionId };

  await db.update(engagement).set({ stripeCheckoutSessionId: `cs_${run}_mine` }).where(eq(engagement.id, engagementId));
  const payment = { paymentIntentId: `pi_${run}_stray`, amountTotal: 14_000, currency: "usd" };
  assert.deepEqual(await fulfilCheckout({ ...ids, checkoutSessionId: `cs_${run}_stray`, payment }), { outcome: "other_session" });
  assert.deepEqual(await releaseCheckout({ ...ids, checkoutSessionId: `cs_${run}_stray` }), { outcome: "other_session" });
  assert.deepEqual(await releaseCheckout({ ...ids, checkoutSessionId: null }), { outcome: "other_session" });
  assert.deepEqual(await state(engagementId), { status: "pending_payment", sessions: ["held"], ledger: [] });

  assert.deepEqual(await releaseCheckout({ ...ids, checkoutSessionId: `cs_${run}_mine` }), { outcome: "released" });
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });
});

test("a checkout past its expiry is returned as expired, not reopened", async () => {
  const student = await person(home.institutionId);
  const requestId = await acceptedRequest(student);
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const params = { actor: student, requestId, anchorExamId: null, slotStartsAt: slot };
  const { engagementId } = await purchasePackage(params);
  await db
    .update(engagement)
    .set({ checkoutExpiresAt: new Date(Date.now() - 60_000), stripeCheckoutSessionId: `cs_${run}_expired` })
    .where(eq(engagement.id, engagementId));

  assert.deepEqual(await purchasePackage(params), { outcome: "expired", engagementId, stripeCheckoutSessionId: `cs_${run}_expired` });
  assert.deepEqual(await releaseCheckout({ engagementId, institutionId: home.institutionId, checkoutSessionId: `cs_${run}_expired` }), { outcome: "released" });
  assert.equal(opened(await purchasePackage(params)).amountMinor, 14_000, "released, the request opens a fresh checkout");
});

test("one PaymentIntent cannot fulfil two checkouts", async () => {
  const one = await person(home.institutionId);
  const two = await person(home.institutionId);
  const oneRequest = await acceptedRequest(one);
  const [slot] = await slotsForRequest({ actor: one, requestId: oneRequest });
  const first = await purchasePackage({ actor: one, requestId: oneRequest, anchorExamId: null, slotStartsAt: slot });
  const twoRequest = await acceptedRequest(two);
  const [other] = await slotsForRequest({ actor: two, requestId: twoRequest });
  const second = await purchasePackage({ actor: two, requestId: twoRequest, anchorExamId: null, slotStartsAt: other });

  const payment = { paymentIntentId: `pi_${run}_once`, amountTotal: 14_000, currency: "usd" };
  const on = (engagementId: string) => ({ engagementId, institutionId: home.institutionId, checkoutSessionId: cs(engagementId), payment });
  await fulfilCheckout(on(first.engagementId));
  await assert.rejects(fulfilCheckout(on(second.engagementId)));
  assert.deepEqual(await state(second.engagementId), { status: "pending_payment", sessions: ["held"], ledger: [] });
});

test("a mismatched payment ends the checkout with a discrepancy and no ledger row; the renewal can be bought again", async () => {
  const { student } = await finishedPair();
  await requestRenewal({ actor: student, tutorCourseId, kind: "exam_anchored" });
  const requestId = await pendingRequest(student, tutorCourseId);
  await acceptRequest({ tutor, requestId });
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const params = { actor: student, requestId, anchorExamId: null, slotStartsAt: slot };

  const { engagementId } = await purchasePackage(params);
  const ids = { engagementId, institutionId: home.institutionId, checkoutSessionId: cs(engagementId) };
  assert.equal(await bookAgain(student, tutorCourseId), null, "a package mid-checkout is not offered again");

  const short = { paymentIntentId: `pi_${run}_short`, amountTotal: 100, currency: "usd" };
  const result = await fulfilCheckout({ ...ids, payment: short });
  assert.equal(result.outcome, "discrepancy");
  const { discrepancyId, ...amounts } = result as Extract<FulfilResult, { outcome: "discrepancy" }>;
  assert.deepEqual(amounts, { outcome: "discrepancy", expectedMinor: 14_000, expectedCurrency: "usd", paidMinor: 100, paidCurrency: "usd" });
  assert.deepEqual(await fulfilCheckout({ ...ids, payment: short }), result, "a redelivered event finds the same discrepancy");

  const [recorded] = await db.select().from(moneyDiscrepancy).where(eq(moneyDiscrepancy.id, discrepancyId));
  assert.equal(recorded.kind, "checkout_amount");
  assert.equal(recorded.stripeReference, short.paymentIntentId);
  assert.equal(recorded.ledgerAmountMinor, 14_000);
  assert.equal(recorded.stripeAmountMinor, 100);
  assert.equal(recorded.refundReference, null);
  assert.equal(recorded.resolvedAt, null);
  assert.deepEqual(await state(engagementId), { status: "cancelled", sessions: ["cancelled"], ledger: [] });

  assert.deepEqual(await releaseCheckout(ids), { outcome: "not_pending", status: "cancelled" });
  const late = { paymentIntentId: `pi_${run}_late`, amountTotal: 14_000, currency: "usd" };
  assert.deepEqual(await fulfilCheckout({ ...ids, payment: late }), { outcome: "not_pending", status: "cancelled" });

  assert.ok((await slotsForRequest({ actor: student, requestId })).some((open) => open.getTime() === slot.getTime()));
  assert.deepEqual(onBoard(await sessionBoardForStudent(student), engagementId), []);
  assert.deepEqual(onBoard(await sessionBoardForTutor(tutor), engagementId), []);
  assert.deepEqual((await bookAgain(student, tutorCourseId))?.liveRequest, { id: requestId, status: "accepted", requestedKind: "exam_anchored" });

  const retry = await purchasePackage(params);
  assert.notEqual(retry.engagementId, engagementId);
  const euros = { paymentIntentId: `pi_${run}_eur`, amountTotal: 14_000, currency: "eur" };
  const retryIds = { engagementId: retry.engagementId, institutionId: home.institutionId, checkoutSessionId: cs(retry.engagementId) };
  assert.equal((await fulfilCheckout({ ...retryIds, payment: euros })).outcome, "discrepancy", "the wrong currency is a mismatch too");

  await buyPackage(params);
  assert.equal(await bookAgain(student, tutorCourseId), null);
});

test("two students racing for the same slot: one gets it", async () => {
  const { student: first } = await finishedPair();
  const { student: second } = await finishedPair();
  const [slot] = await slotsForTopUp({ actor: first, tutorCourseId });

  const results = await Promise.allSettled([
    buyTopUp({ actor: first, tutorCourseId, slotStartsAt: slot }),
    buyTopUp({ actor: second, tutorCourseId, slotStartsAt: slot }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionBooking)
    .where(and(eq(sessionBooking.institutionId, home.institutionId), eq(sessionBooking.scheduledAt, slot), sql`${sessionBooking.status} <> 'cancelled'`));
  assert.equal(n, 1);
});

test("two tutors accepting the same student's asks at once: one wins, the other is told cleanly", async () => {
  const student = await person(home.institutionId);
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId, otherTutorCourseId], kind: "exam_anchored" });
  const [mine, theirs] = await Promise.all([pendingRequest(student, tutorCourseId), pendingRequest(student, otherTutorCourseId)]);

  const results = await Promise.allSettled([
    acceptRequest({ tutor, requestId: mine }),
    acceptRequest({ tutor: otherTutor, requestId: theirs }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const lost = results.find((result) => result.status === "rejected");
  assert.ok(lost?.reason instanceof RequestError, String(lost?.reason));

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, student.studentProfileId), eq(matchRequest.status, "accepted")));
  assert.equal(n, 1);
});

test("a session booking and a refill racing for one slot: one gets it", async () => {
  for (const headStartMs of [0, 2, 4, 6, 8, 12]) {
    const booker = await person(home.institutionId);
    const engagementId = await boughtPackage(booker);
    const { student: refiller } = await finishedPair();
    const [slot] = await slotsForEngagement({ actor: booker, engagementId });

    const results = await Promise.allSettled([
      buyTopUp({ actor: refiller, tutorCourseId, slotStartsAt: slot }),
      new Promise((resolve) => setTimeout(resolve, headStartMs)).then(() =>
        bookSession({ actor: booker, engagementId, slotStartsAt: slot }),
      ),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1, `head start ${headStartMs}ms`);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionBooking)
      .where(and(eq(sessionBooking.institutionId, home.institutionId), eq(sessionBooking.scheduledAt, slot), sql`${sessionBooking.status} <> 'cancelled'`));
    assert.equal(n, 1);
  }
});

test("a booking against a package refunded while it waits is refused", async () => {
  const student = await person(home.institutionId);
  const engagementId = await boughtPackage(student);
  const [slot] = await slotsForEngagement({ actor: student, engagementId });

  let booking: Promise<unknown> = Promise.resolve();
  await db.transaction(async (tx) => {
    await tx.select({ id: engagement.id }).from(engagement).where(eq(engagement.id, engagementId)).for("update");
    booking = bookSession({ actor: student, engagementId, slotStartsAt: slot }).then(
      () => "booked",
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const [{ pricePaidMinor }] = await tx
      .update(engagement)
      .set({ status: "refunded", completedAt: new Date() })
      .where(eq(engagement.id, engagementId))
      .returning({ pricePaidMinor: engagement.pricePaidMinor });
    await tx.insert(ledgerEntry).values({ engagementId, institutionId: home.institutionId, type: "refund", amountMinor: pricePaidMinor });
  });

  assert.ok((await booking) instanceof SessionError);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(sessionBooking).where(eq(sessionBooking.engagementId, engagementId));
  assert.equal(n, 1, "only the session bought with the package");
});

test("the request email names the package the tutor would commit to", () => {
  const email = requestWaiting({ to: "t@example.test", tutorName: "Tutor", studentName: "Student", courseLabel: "REN 1", requestedKind: "through_final", expiresAt: new Date() });
  assert.match(email.text, /They asked for 8 sessions, through the final\./);
  const legacy = requestWaiting({ to: "t@example.test", tutorName: "Tutor", studentName: "Student", courseLabel: "REN 1", requestedKind: null, expiresAt: new Date() });
  assert.doesNotMatch(legacy.text, /They asked for/);
});

test("the ledger keeps its money invariants across every scenario above", async () => {
  for (const institutionId of made.institutions) await assertMoneyInvariants(institutionId);
});
