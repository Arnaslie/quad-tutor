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
import {
  PurchaseError,
  purchasePackage,
  purchaseTopUp,
  slotsForRequest,
  slotsForTopUp,
} from "./purchase";
import { bookAgain, bookAgainList } from "./reads";
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

async function boughtPackage(student: Actor): Promise<string> {
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [tutorCourseId], kind: "exam_anchored" });
  const requestId = await pendingRequest(student, tutorCourseId);
  await acceptRequest({ tutor, requestId });
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const { engagementId } = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  return engagementId;
}

async function finishedPair(): Promise<{ student: Actor; engagementId: string }> {
  const student = await person(home.institutionId);
  const engagementId = await boughtPackage(student);
  await db.update(engagement).set({ sessionsPurchased: 1 }).where(eq(engagement.id, engagementId));
  return { student, engagementId };
}

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
  const { engagementId } = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
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
  const { engagementId } = await purchasePackage({ actor: student, requestId: legacy.id, kind: "through_final", anchorExamId: null, slotStartsAt: slot });
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
  const { engagementId } = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  await assert.rejects(bookSession({ actor: student, engagementId, slotStartsAt: offHours }), SessionError);
  await assert.rejects(bookSession({ actor: student, engagementId, slotStartsAt: slot }), SessionError, "already taken");
  await bookSession({ actor: student, engagementId, slotStartsAt: next });

  const { student: refiller } = await finishedPair();
  await assert.rejects(purchaseTopUp({ actor: refiller, tutorCourseId, slotStartsAt: offHours }), PurchaseError);
  await assert.rejects(purchaseTopUp({ actor: refiller, tutorCourseId, slotStartsAt: slot }), PurchaseError);
  assert.equal(await topUps(refiller), 0);
});

test("two refills for one slot at once: exactly one is bought, with one deferred ledger row", async () => {
  const { student } = await finishedPair();
  const [slot] = await slotsForTopUp({ actor: student, tutorCourseId });

  const results = await Promise.allSettled([
    purchaseTopUp({ actor: student, tutorCourseId, slotStartsAt: slot }),
    purchaseTopUp({ actor: student, tutorCourseId, slotStartsAt: slot }),
  ]);
  const won = results.filter((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected");
  assert.equal(won.length, 1);
  assert.ok(lost[0].reason instanceof PurchaseError);
  assert.equal(await topUps(student), 1);

  const { engagementId } = (won[0] as PromiseFulfilledResult<{ engagementId: string }>).value;
  const ledger = await db.select({ type: ledgerEntry.type, amountMinor: ledgerEntry.amountMinor }).from(ledgerEntry).where(eq(ledgerEntry.engagementId, engagementId));
  assert.deepEqual(ledger, [{ type: "package_purchase", amountMinor: 3_500 }]);
  const facts = await db.select({ id: reliabilityEvent.id }).from(reliabilityEvent).where(eq(reliabilityEvent.userId, student.userId));
  assert.equal(facts.length, 0);

  assert.ok(await bookAgain(student, tutorCourseId), "a booked refill leaves nothing to book, so refills chain");
});

test("two students racing for the same slot: one gets it", async () => {
  const { student: first } = await finishedPair();
  const { student: second } = await finishedPair();
  const [slot] = await slotsForTopUp({ actor: first, tutorCourseId });

  const results = await Promise.allSettled([
    purchaseTopUp({ actor: first, tutorCourseId, slotStartsAt: slot }),
    purchaseTopUp({ actor: second, tutorCourseId, slotStartsAt: slot }),
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
      purchaseTopUp({ actor: refiller, tutorCourseId, slotStartsAt: slot }),
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
