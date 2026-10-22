import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";

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
import { pay } from "@/server/modules/engagements/buy-and-pay";
import {
  purchasePackage,
  purchaseTopUp,
  slotsForRequest,
  slotsForTopUp,
  type Checkout,
  type PurchaseResult,
} from "@/server/modules/engagements/purchase";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import {
  acceptRequest,
  inboxForTutor,
  requestTutors,
  requestsForStudent,
} from "@/server/modules/matching/requests";
import { notifyAcceptedRequests } from "@/server/modules/notifications/dispatch";

import { TutoringError, coursesForTutor, setCourseRate } from "./courses";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

let home: { institutionId: string; termId: string; courseId: string; offeringId: string };

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

let people = 0;
async function person(): Promise<Actor> {
  const id = `test_rates_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db
    .insert(studentProfile)
    .values({ userId: id, institutionId: home.institutionId })
    .returning({ id: studentProfile.id });
  return {
    userId: id,
    name: id,
    email: `${id}@example.test`,
    institutionId: home.institutionId,
    studentProfileId: profile.id,
    tutorProfileId: null,
  };
}

async function tutorWithClaim(): Promise<{ tutor: TutorActor; claimId: string }> {
  const base = await person();
  const [profile] = await db
    .insert(tutorProfile)
    .values({ userId: base.userId, institutionId: home.institutionId })
    .returning({ id: tutorProfile.id });
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
    .values({
      tutorProfileId: profile.id,
      institutionId: home.institutionId,
      courseId: home.courseId,
      takenTermId: home.termId,
      gradeEarned: "A",
      status: "active",
    })
    .returning({ id: tutorCourse.id });
  return { tutor: { ...base, tutorProfileId: profile.id }, claimId: claim.id };
}

async function accepted(student: Actor, tutor: TutorActor, claimId: string): Promise<string> {
  await requestTutors({
    actor: student,
    courseOfferingId: home.offeringId,
    tutorCourseIds: [claimId],
    kind: "exam_anchored",
  });
  const [row] = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(
      and(
        eq(matchRequest.studentProfileId, student.studentProfileId),
        eq(matchRequest.tutorCourseId, claimId),
        eq(matchRequest.status, "pending"),
      ),
    );
  await acceptRequest({ tutor, requestId: row.id });
  return row.id;
}

function opened(result: PurchaseResult): Checkout {
  assert.equal(result.outcome, "checkout");
  return (result as Extract<PurchaseResult, { outcome: "checkout" }>).checkout;
}

async function rateOf(claimId: string): Promise<number> {
  const [row] = await db
    .select({ rate: tutorCourse.sessionRateMinor })
    .from(tutorCourse)
    .where(eq(tutorCourse.id, claimId));
  return row.rate;
}

before(async () => {
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test rates", slug: `rates-${run}`, emailDomain: `rates-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);
  const [termRow] = await db
    .insert(term)
    .values({ institutionId: inst.id, name: "Now", startsOn: inDays(-30), endsOn: inDays(60) })
    .returning({ id: term.id });
  const [courseRow] = await db
    .insert(course)
    .values({ institutionId: inst.id, title: "Rates 101", department: "TEST" })
    .returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `RAT ${run}` });
  const [offering] = await db
    .insert(courseOffering)
    .values({ institutionId: inst.id, courseId: courseRow.id, termId: termRow.id, section: "001" })
    .returning({ id: courseOffering.id });
  home = { institutionId: inst.id, termId: termRow.id, courseId: courseRow.id, offeringId: offering.id };
});

after(async () => {
  const institutions = made.institutions;
  const engagements = (
    await db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.institutionId, institutions))
  ).map((row) => row.id);
  if (engagements.length) {
    await db.delete(moneyDiscrepancy).where(inArray(moneyDiscrepancy.engagementId, engagements));
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
  await db.delete(matchRequest).where(inArray(matchRequest.institutionId, institutions));
  await db.delete(messageThread).where(inArray(messageThread.institutionId, institutions));
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

test("a rate change after the accept keeps the quoted package price, and a top-up pays the new rate", async () => {
  const { tutor, claimId } = await tutorWithClaim();
  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 4_000 });
  const student = await person();
  const requestId = await accepted(student, tutor, claimId);

  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 5_000 });
  assert.equal(await rateOf(claimId), 5_000);
  const [asked] = await requestsForStudent(student);
  assert.equal(asked.rateMinor, 4_000, "the student sees the price the tutor accepted at");

  const [slot] = await slotsForRequest({ actor: student, requestId });
  const packageResult = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  assert.equal(opened(packageResult).amountMinor, 16_000);
  const { engagementId } = await pay(packageResult);
  await db.update(engagement).set({ sessionsPurchased: 1 }).where(eq(engagement.id, engagementId));

  const [topUpSlot] = await slotsForTopUp({ actor: student, tutorCourseId: claimId });
  const topUp = await purchaseTopUp({ actor: student, tutorCourseId: claimId, slotStartsAt: topUpSlot });
  assert.equal(opened(topUp).amountMinor, 5_000);

  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 3_000 });
  const resumed = await purchaseTopUp({ actor: student, tutorCourseId: claimId, slotStartsAt: topUpSlot });
  assert.equal(opened(resumed).amountMinor, 5_000, "an open top-up checkout keeps the rate it was created at");

  const charged = await db
    .select({ kind: engagement.kind, pricePaidMinor: engagement.pricePaidMinor })
    .from(engagement)
    .where(eq(engagement.studentProfileId, student.studentProfileId))
    .orderBy(engagement.createdAt);
  assert.deepEqual(charged, [
    { kind: "exam_anchored", pricePaidMinor: 16_000 },
    { kind: "top_up", pricePaidMinor: 5_000 },
  ]);
});

test("a request accepted before quotes existed keeps the flat price after a rate change", async () => {
  const { tutor, claimId } = await tutorWithClaim();
  const student = await person();
  const requestId = await accepted(student, tutor, claimId);
  await db.update(matchRequest).set({ quotedRateMinor: null }).where(eq(matchRequest.id, requestId));

  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 5_000 });
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const result = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  assert.equal(opened(result).amountMinor, 14_000);
});

test("a request accepted after the change pays the new rate", async () => {
  const { tutor, claimId } = await tutorWithClaim();
  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 2_500 });

  const student = await person();
  const requestId = await accepted(student, tutor, claimId);
  const [slot] = await slotsForRequest({ actor: student, requestId });
  const result = await purchasePackage({ actor: student, requestId, anchorExamId: null, slotStartsAt: slot });
  assert.equal(opened(result).amountMinor, 10_000);
});

test("a tutor cannot set the rate on another tutor's claim", async () => {
  const { tutor } = await tutorWithClaim();
  const { claimId: theirs } = await tutorWithClaim();

  await assert.rejects(
    setCourseRate({ tutor, tutorCourseId: theirs, rateMinor: 5_000 }),
    (error) => error instanceof TutoringError && error.message === "That course is not one you tutor.",
  );
  assert.equal(await rateOf(theirs), 3_500);
});

test("a tutor's own claim is refused under another campus", async () => {
  const { tutor, claimId } = await tutorWithClaim();

  await assert.rejects(
    setCourseRate({ tutor: { ...tutor, institutionId: randomUUID() }, tutorCourseId: claimId, rateMinor: 5_000 }),
    TutoringError,
  );
  assert.equal(await rateOf(claimId), 3_500);
});

test("the tutor's course list carries each claim's rate", async () => {
  const { tutor, claimId } = await tutorWithClaim();
  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 4_200 });

  const claims = await coursesForTutor(tutor);
  assert.deepEqual(
    claims.map((claim) => ({ id: claim.id, sessionRateMinor: claim.sessionRateMinor })),
    [{ id: claimId, sessionRateMinor: 4_200 }],
  );
});

async function acceptedEmailText(t: TestContext, requestId: string): Promise<string> {
  const lines: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => lines.push(args.join(" ")));
  await notifyAcceptedRequests(home.institutionId);
  t.mock.restoreAll();
  const key = lines.findIndex((line) => line.includes(`[email] idempotency-key: request-accepted/${requestId}`));
  assert.notEqual(key, -1, "the accept email was sent");
  return lines[key + 1].trimEnd();
}

test("a rate change between ask and accept is shown to the tutor, on the purchase panel and in the accept email", async (t) => {
  const { tutor, claimId } = await tutorWithClaim();
  await db.update(user).set({ name: "Riley" }).where(eq(user.id, tutor.userId));
  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 3_500 });
  const student = await person();
  await requestTutors({ actor: student, courseOfferingId: home.offeringId, tutorCourseIds: [claimId], kind: "exam_anchored" });

  const [asked] = await requestsForStudent(student);
  assert.equal(asked.requestedRateMinor, 3_500);

  await setCourseRate({ tutor, tutorCourseId: claimId, rateMinor: 4_000 });
  const [inbox] = await inboxForTutor(tutor);
  assert.deepEqual(
    { requestedRateMinor: inbox.requestedRateMinor, sessionRateMinor: inbox.sessionRateMinor },
    { requestedRateMinor: 3_500, sessionRateMinor: 4_000 },
  );

  await acceptRequest({ tutor, requestId: asked.id });
  const [saidYes] = await requestsForStudent(student);
  assert.deepEqual(
    { requestedRateMinor: saidYes.requestedRateMinor, rateMinor: saidYes.rateMinor },
    { requestedRateMinor: 3_500, rateMinor: 4_000 },
  );

  assert.equal(
    await acceptedEmailText(t, asked.id),
    [
      `${student.name},`,
      "",
      `Riley said yes to RAT ${run}.`,
      "",
      "Riley raised their price from $35.00 to $40.00 a session since you asked.",
      "",
      "Pick a package and a time to lock it in. Nothing is charged until you do.",
      "",
      `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/requests`,
      "",
      "— Quad Tutor",
    ].join("\n"),
  );
});

test("an accept at the price the student asked at sends the email without a price line", async (t) => {
  const { tutor, claimId } = await tutorWithClaim();
  const student = await person();
  const requestId = await accepted(student, tutor, claimId);

  assert.equal((await acceptedEmailText(t, requestId)).includes("price"), false);
});
