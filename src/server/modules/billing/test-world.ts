import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  institution,
  ledgerEntry,
  ledgerEntryType,
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
import { bookSession, slotsForEngagement } from "@/server/modules/engagements/scheduling";
import type { Actor, OperatorActor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";

import { checkoutRedirect, syncCheckout } from "./checkout-session";
import { ensureConnectAccount, syncConnectAccount } from "./connect";
import { fakeStripe, stripeGateway, type Gateway } from "./stripe";
import { handleStripeWebhook } from "./webhook";

process.env.STRIPE_FAKE = "1";
process.env.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(16).toString("hex")}`;
delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

export const run = randomUUID().slice(0, 8);
const users: string[] = [];
const campuses: string[] = [];

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export type World = {
  prefix: string;
  institutionId: string;
  offeringId: string;
  termId: string;
  courseCode: string;
  tutor: TutorActor;
  tutorCourseId: string;
  accountId: string;
};

let people = 0;
export async function person(institutionId: string, prefix = "test_money"): Promise<Actor> {
  const id = `${prefix}_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  users.push(id);
  const [profile] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

export async function operator(institutionId: string): Promise<OperatorActor> {
  return { ...(await person(institutionId)), operatorInstitutionIds: [institutionId] };
}

/** A campus of its own per test, so counts and the lease never mix, with a tutor Stripe has verified. */
export async function world(prefix = "test_money"): Promise<World> {
  const slug = `money-${run}-${campuses.length}`;
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test money", slug, emailDomain: `${slug}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  campuses.push(inst.id);
  const [now] = await db.insert(term).values({ institutionId: inst.id, name: "Now", startsOn: inDays(-30), endsOn: inDays(60) }).returning({ id: term.id });
  const [courseRow] = await db.insert(course).values({ institutionId: inst.id, title: "Money 101", department: "TEST" }).returning({ id: course.id });
  const courseCode = `MNY ${slug}`;
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: courseCode });
  const [offering] = await db.insert(courseOffering).values({ institutionId: inst.id, courseId: courseRow.id, termId: now.id, section: "001" }).returning({ id: courseOffering.id });

  const base = await person(inst.id, prefix);
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
  return { prefix, institutionId: inst.id, offeringId: offering.id, termId: now.id, courseCode, tutor, tutorCourseId: claim.id, accountId };
}

/** A student whose request the tutor accepted, and the four-pack they would buy. */
export async function accepted(w: World, prefix = w.prefix) {
  const actor = await person(w.institutionId, prefix);
  await requestTutors({ actor, courseOfferingId: w.offeringId, tutorCourseIds: [w.tutorCourseId], kind: "exam_anchored" });
  const [request] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(and(eq(matchRequest.studentProfileId, actor.studentProfileId), eq(matchRequest.status, "pending")));
  await acceptRequest({ tutor: w.tutor, requestId: request.id });
  const [slot] = await slotsForRequest({ actor, requestId: request.id });
  return { actor, buy: () => purchasePackage({ actor, requestId: request.id, anchorExamId: null, slotStartsAt: slot }) };
}

/** A four-pack held at checkout, not yet paid. */
export async function checkingOut(w: World) {
  const { actor, buy } = await accepted(w);
  await checkoutRedirect(w.institutionId, buy);
  const [row] = await db
    .select({ id: engagement.id, sessionId: engagement.stripeCheckoutSessionId })
    .from(engagement)
    .where(and(eq(engagement.studentProfileId, actor.studentProfileId), eq(engagement.status, "pending_payment")));
  return { actor, engagementId: row.id, checkoutSessionId: row.sessionId! };
}

export async function firstSessionDelivered(w: World, actor: Actor, engagementId: string) {
  const [session] = await db.select({ id: sessionBooking.id }).from(sessionBooking).where(eq(sessionBooking.engagementId, engagementId));
  await db.update(sessionBooking).set({ scheduledAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(sessionBooking.id, session.id));
  await confirmAttendance({ actor, sessionId: session.id });
  assert.equal((await confirmAttendance({ actor: w.tutor, sessionId: session.id })).status, "completed");
}

/** Paid through the fake, its first session confirmed by both sides so `recognise()` accrues it. */
export async function delivered(w: World) {
  const { actor, engagementId, checkoutSessionId } = await checkingOut(w);
  await fakeStripe.pay(checkoutSessionId);
  assert.equal((await syncCheckout(checkoutSessionId)).outcome, "fulfilled");
  await firstSessionDelivered(w, actor, engagementId);

  const [paid] = await db
    .select({ pi: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "package_purchase")));
  return { actor, engagementId, checkoutSessionId, paymentIntentId: paid.pi! };
}

export async function anotherSessionDelivered(w: World, actor: Actor, engagementId: string) {
  const [slot] = await slotsForEngagement({ actor, engagementId });
  const { sessionId } = await bookSession({ actor, engagementId, slotStartsAt: slot });
  await db.update(sessionBooking).set({ scheduledAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(sessionBooking.id, sessionId));
  await confirmAttendance({ actor, sessionId });
  assert.equal((await confirmAttendance({ actor: w.tutor, sessionId })).status, "completed");
}

type LedgerType = (typeof ledgerEntryType.enumValues)[number];

export async function rows(engagementId: string, type: LedgerType) {
  return db
    .select({
      id: ledgerEntry.id,
      amountMinor: ledgerEntry.amountMinor,
      stripeReference: ledgerEntry.stripeReference,
      correctsEntryId: ledgerEntry.correctsEntryId,
    })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, type)))
    .orderBy(ledgerEntry.occurredAt, ledgerEntry.id);
}

/** The engagement's newest refund row, named the way the call after commit names it. */
export async function newestRefund(engagementId: string): Promise<{ id: string; engagementId: string; institutionId: string }> {
  const [row] = await db
    .select({ id: ledgerEntry.id, engagementId: ledgerEntry.engagementId, institutionId: ledgerEntry.institutionId })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "refund")))
    .orderBy(desc(ledgerEntry.occurredAt), desc(ledgerEntry.id))
    .limit(1);
  assert.ok(row, `no refund row on ${engagementId}`);
  return row;
}

/** Puts the rows back in time, as if the call after commit died that long ago. */
export async function age(engagementId: string, type: LedgerType, ms: number) {
  await db
    .update(ledgerEntry)
    .set({ occurredAt: new Date(Date.now() - ms) })
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, type)));
}

export async function patched<K extends keyof Gateway>(name: K, replacement: Gateway[K], work: () => Promise<void>) {
  const gateway = stripeGateway();
  const original = gateway[name];
  gateway[name] = replacement;
  try {
    await work();
  } finally {
    gateway[name] = original;
  }
}

/** Every gateway method throws while the work runs. */
export async function noStripe(work: () => Promise<void>) {
  const gateway = stripeGateway();
  const methods = Object.keys(gateway).filter((key) => typeof gateway[key as keyof Gateway] === "function") as (keyof Gateway)[];
  const originals = new Map(methods.map((name) => [name, gateway[name]]));
  for (const name of methods) Object.assign(gateway, { [name]: async () => { throw new Error(`no Stripe call: ${name}`); } });
  try {
    await work();
  } finally {
    for (const [name, original] of originals) Object.assign(gateway, { [name]: original });
  }
}

export async function deliver(event: { payload: string; signature: string }) {
  return handleStripeWebhook(event.payload, event.signature);
}

export async function cleanup() {
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.institutionId, campuses))).map((row) => row.id);
  await db.delete(paymentDispute).where(inArray(paymentDispute.institutionId, campuses));
  await db.delete(moneyDiscrepancy).where(inArray(moneyDiscrepancy.institutionId, campuses));
  if (engagements.length) {
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
}

export const allCampuses = () => [...campuses];
