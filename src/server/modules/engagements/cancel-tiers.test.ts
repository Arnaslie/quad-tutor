import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";

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
  reliabilityEvent,
  sessionBooking,
  sessionRating,
  studentProfile,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { assertMoneyInvariants } from "@/server/modules/billing/invariants";
import { notifyCancelledSessions } from "@/server/modules/notifications/dispatch";
import { sessionBooked, sessionTomorrow } from "@/server/modules/notifications/messages";
import { rateSession } from "@/server/modules/ratings/capture";
import { sessionRatingState } from "@/server/modules/ratings/reads";

import { SessionError } from "./access";
import { confirmAttendance } from "./confirmation";
import { packagesForStudent, sessionDetail } from "./reads";
import { bookSession, cancelSession, sessionsRemaining } from "./scheduling";
import { availableSlots } from "./slots";
import { closeWithRefund, endPackage } from "./termEnd";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

let institutionId: string;
let termId: string;
let courseId: string;
let offeringId: string;
let tutor: TutorActor;
let tutorCourseId: string;

const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

let people = 0;
async function person(): Promise<Actor> {
  const id = `test_cancel_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

async function newTutor(): Promise<{ actor: TutorActor; claimId: string }> {
  const base = await person();
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tutorProfileId: profile.id, institutionId, weekday, startMinute: 0, endMinute: 24 * 60 })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId, courseId, takenTermId: termId, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  return { actor: { ...base, tutorProfileId: profile.id }, claimId: claim.id };
}

async function pkg(student: Actor, kind: "exam_anchored" | "top_up" = "exam_anchored", claimId = tutorCourseId): Promise<string> {
  const single = kind === "top_up";
  const [row] = await db
    .insert(engagement)
    .values({
      institutionId,
      studentProfileId: student.studentProfileId,
      tutorCourseId: claimId,
      courseOfferingId: offeringId,
      kind,
      sessionsPurchased: single ? 1 : 4,
      pricePaidMinor: single ? 3_500 : 14_000,
    })
    .returning({ id: engagement.id, pricePaidMinor: engagement.pricePaidMinor });
  await db.insert(ledgerEntry).values({ engagementId: row.id, institutionId, type: "package_purchase", amountMinor: row.pricePaidMinor });
  return row.id;
}

async function session(engagementId: string, at: Date, fields: Partial<typeof sessionBooking.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(sessionBooking)
    .values({ engagementId, institutionId, scheduledAt: at, confirmationWindowEndsAt: new Date(at.getTime() + 25 * 3_600_000), ...fields })
    .returning({ id: sessionBooking.id });
  return row.id;
}

async function attended(engagementId: string, at: Date): Promise<string> {
  const id = await session(engagementId, at, { studentConfirmedAt: new Date() });
  assert.equal((await confirmAttendance({ actor: tutor, sessionId: id })).status, "completed");
  return id;
}

async function ledger(engagementId: string) {
  const rows = await db
    .select({ type: ledgerEntry.type, amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.engagementId, engagementId));
  return rows.sort((a, b) => a.type.localeCompare(b.type) || a.amountMinor - b.amountMinor);
}

async function statusOf(engagementId: string) {
  const [row] = await db.select({ status: engagement.status }).from(engagement).where(eq(engagement.id, engagementId));
  return row.status;
}

async function facts(student: Actor) {
  return (await db.select({ type: reliabilityEvent.type }).from(reliabilityEvent).where(eq(reliabilityEvent.userId, student.userId))).map((row) => row.type);
}

const left = (engagementId: string, sessionsPurchased = 4) => sessionsRemaining({ engagementId, sessionsPurchased });

before(async () => {
  const [inst] = await db
    .insert(institution)
    .values({ name: "Test cancel", slug: `cancel-${run}`, emailDomain: `cancel-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  institutionId = inst.id;
  made.institutions.push(inst.id);
  const today = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const [termRow] = await db.insert(term).values({ institutionId, name: "Now", startsOn: today(-30), endsOn: today(60) }).returning({ id: term.id });
  termId = termRow.id;
  const [courseRow] = await db.insert(course).values({ institutionId, title: "Cancel 101", department: "TEST" }).returning({ id: course.id });
  courseId = courseRow.id;
  await db.insert(courseCodeAlias).values({ institutionId, courseId, code: `CXL ${run}` });
  const [offering] = await db.insert(courseOffering).values({ institutionId, courseId, termId, section: "001" }).returning({ id: courseOffering.id });
  offeringId = offering.id;

  ({ actor: tutor, claimId: tutorCourseId } = await newTutor());
});

after(async () => {
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(eq(engagement.institutionId, institutionId))).map((row) => row.id);
  await db.delete(sessionRating).where(eq(sessionRating.institutionId, institutionId));
  await db.delete(reliabilityEvent).where(eq(reliabilityEvent.institutionId, institutionId));
  if (engagements.length) {
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
  await db.delete(tutorAvailability).where(eq(tutorAvailability.institutionId, institutionId));
  await db.delete(tutorCourse).where(eq(tutorCourse.institutionId, institutionId));
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, made.users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, made.users));
  await db.delete(user).where(inArray(user.id, made.users));
  await db.delete(courseOffering).where(eq(courseOffering.institutionId, institutionId));
  await db.delete(courseCodeAlias).where(eq(courseCodeAlias.institutionId, institutionId));
  await db.delete(course).where(eq(course.institutionId, institutionId));
  await db.delete(term).where(eq(term.institutionId, institutionId));
  await db.delete(institution).where(eq(institution.id, institutionId));
  await db.$client.end();
});

/** The refund rows on a package, oldest first, with the session each one is for. */
async function refunds(engagementId: string) {
  return db
    .select({ id: ledgerEntry.id, sessionId: ledgerEntry.sessionId, amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.engagementId, engagementId), eq(ledgerEntry.type, "refund")))
    .orderBy(ledgerEntry.occurredAt, ledgerEntry.amountMinor);
}

const refs = (engagementId: string, rows: { id: string }[]) => rows.map(({ id }) => ({ id, engagementId, institutionId }));

test("a student cancel of a four-pack session 24 hours or more ahead moves no money and the session goes back in the package", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(30));

  assert.deepEqual(await cancelSession({ actor: student, sessionId }), {
    late: false,
    keptMinor: 0,
    returnedMinor: 3_500,
    currency: "usd",
    refundedMinor: 0,
    refunds: [],
  });
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 14_000 }]);
  assert.equal(await left(id), 4);
  assert.deepEqual(await facts(student), []);
});

test("a student cancel 12 to 24 hours ahead of a $35 session pays the tutor half and sends the other half to the card now", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(20));

  const outcome = await cancelSession({ actor: student, sessionId });
  const rows = await refunds(id);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.amountMinor]), [[sessionId, 1_750]]);
  assert.deepEqual(outcome, { late: false, keptMinor: 1_750, returnedMinor: 1_750, currency: "usd", refundedMinor: 1_750, refunds: refs(id, rows) });
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 14_000 },
    { type: "platform_fee", amountMinor: 175 },
    { type: "refund", amountMinor: 1_750 },
    { type: "session_earned", amountMinor: 1_750 },
    { type: "tutor_accrued", amountMinor: 1_575 },
  ]);
  assert.equal(await left(id), 3, "the cancelled session is used");
  assert.deepEqual(await facts(student), [], "outside 12 hours it is not a late cancel");
  assert.equal(await statusOf(id), "active");

  const [preview] = (await packagesForStudent(student)).filter((row) => row.engagementId === id);
  assert.equal(preview.ending.backMinor, 9_450, "ending gives back the three sessions left, less the 10% end fee");
  assert.equal((await endPackage({ actor: student, engagementId: id }))?.refundMinor, 9_450);
  assert.equal(await statusOf(id), "refunded", "nothing was attended");
});

test("a student cancel inside 12 hours pays the tutor three quarters, sends a quarter to the card now, and is a late cancel", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(5));

  const outcome = await cancelSession({ actor: student, sessionId });
  assert.deepEqual([outcome.late, outcome.keptMinor, outcome.refundedMinor], [true, 2_625, 875]);
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 14_000 },
    { type: "platform_fee", amountMinor: 262 },
    { type: "refund", amountMinor: 875 },
    { type: "session_earned", amountMinor: 2_625 },
    { type: "tutor_accrued", amountMinor: 2_363 },
  ]);
  assert.equal(await left(id), 3);
  assert.deepEqual(await facts(student), ["late_cancelled"]);
});

test("four $35 sessions, one done, the next cancelled 10 hours ahead: $8.75 back now, $26.25 to the tutor, two left", async () => {
  const student = await person();
  const id = await pkg(student);
  await attended(id, hours(-100));
  const next = await session(id, hours(10));

  const outcome = await cancelSession({ actor: student, sessionId: next });
  assert.deepEqual([outcome.keptMinor, outcome.refundedMinor, outcome.refunds.length], [2_625, 875, 1]);
  const earned = await db
    .select({ amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.sessionId, next), eq(ledgerEntry.type, "session_earned")));
  assert.deepEqual(earned, [{ amountMinor: 2_625 }]);
  assert.deepEqual((await refunds(id)).map((r) => [r.sessionId, r.amountMinor]), [[next, 875]]);
  assert.equal(await left(id), 2);
});

test("a tutor cancel refunds the session's full price to the card now and uses the session up", async () => {
  const student = await person();
  const id = await pkg(student);
  await attended(id, hours(-100));
  const sessionId = await session(id, hours(1));

  const outcome = await cancelSession({ actor: tutor, sessionId });
  const rows = await refunds(id);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.amountMinor]), [[sessionId, 3_500]]);
  assert.deepEqual(outcome, { late: true, keptMinor: 0, returnedMinor: 3_500, currency: "usd", refundedMinor: 3_500, refunds: refs(id, rows) });
  assert.equal(await left(id), 2, "4 bought, 1 done, 1 cancelled by the tutor");
  assert.deepEqual(await facts(student), ["attended"], "a tutor cancel is never the student's fact");
  assert.equal(await statusOf(id), "active");
});

test("a tutor cancel of a one-time session refunds it to the card and closes it", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(30));

  const outcome = await cancelSession({ actor: tutor, sessionId });
  assert.deepEqual([outcome.keptMinor, outcome.refundedMinor, outcome.refunds.length], [0, 3_500, 1]);
  assert.equal(await statusOf(id), "refunded");
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 3_500 },
    { type: "refund", amountMinor: 3_500 },
  ]);
  assert.equal(await left(id, 1), 0);
});

test("cancelling the only session of a single inside 24 hours closes it and refunds the rest at once", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(20));

  const outcome = await cancelSession({ actor: student, sessionId });
  assert.deepEqual([outcome.keptMinor, outcome.refundedMinor], [1_750, 1_750]);
  assert.equal(await statusOf(id), "refunded");
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 3_500 },
    { type: "platform_fee", amountMinor: 175 },
    { type: "refund", amountMinor: 1_750 },
    { type: "session_earned", amountMinor: 1_750 },
    { type: "tutor_accrued", amountMinor: 1_575 },
  ]);
});

test("a student cancel of a one-time session 24 hours or more ahead closes it and refunds the whole $35 to the card", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(30));

  const outcome = await cancelSession({ actor: student, sessionId });
  const rows = await refunds(id);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.amountMinor]), [[sessionId, 3_500]]);
  assert.deepEqual(outcome, { late: false, keptMinor: 0, returnedMinor: 3_500, currency: "usd", refundedMinor: 3_500, refunds: refs(id, rows) });
  assert.equal(await statusOf(id), "refunded");
  assert.deepEqual(await facts(student), []);
  assert.equal((await sessionDetail({ actor: student, sessionId })).sessionsRemaining, 0, "a closed package has nothing left to book");
  assert.equal(await endPackage({ actor: student, engagementId: id }), null, "a second close finds nothing to refund");
});

test("a student cancel of a one-time session inside 12 hours keeps 75% and refunds $8.75 at once", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(5));

  const outcome = await cancelSession({ actor: student, sessionId });
  assert.deepEqual([outcome.late, outcome.keptMinor, outcome.refundedMinor], [true, 2_625, 875]);
  assert.equal(await statusOf(id), "refunded");
  assert.deepEqual((await refunds(id)).map((r) => r.amountMinor), [875]);
  assert.deepEqual(await facts(student), ["late_cancelled"]);
});

test("a free one-time cancel racing the term-end sweep never deadlocks and leaves one full refund", async () => {
  const winners = new Set<string>();
  for (const delayed of ["cancel", "sweep"] as const) {
    for (const headStartMs of [0, 1, 2, 4, 8]) {
      const student = await person();
      const id = await pkg(student, "top_up");
      const sessionId = await session(id, hours(30));
      const start = <T>(who: typeof delayed, run: () => Promise<T>) =>
        new Promise((resolve) => setTimeout(resolve, who === delayed ? headStartMs : 0)).then(run);

      const [sweep, cancel] = await Promise.allSettled([
        start("sweep", () => db.transaction((tx) => closeWithRefund(tx, { engagementId: id, institutionId }))),
        start("cancel", () => cancelSession({ actor: student, sessionId })),
      ]);
      const label = `${delayed} delayed ${headStartMs}ms`;
      assert.equal(sweep.status, "fulfilled", `${label}: ${sweep.status === "rejected" && sweep.reason}`);
      if (cancel.status === "rejected") assert.ok(cancel.reason instanceof SessionError, String(cancel.reason));
      winners.add(cancel.status === "fulfilled" && cancel.value.refundedMinor > 0 ? "cancel" : "sweep");
      assert.deepEqual((await refunds(id)).map((r) => r.amountMinor), [3_500], label);
      assert.equal(await statusOf(id), "refunded", label);
    }
  }
  assert.deepEqual([...winners].sort(), ["cancel", "sweep"], "both orders were exercised");
});

test("a booking waiting on the tutor while a free one-time cancel commits is refused, and the package then closes", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(30));
  const slot = (await availableSlots({ tutorProfileId: tutor.tutorProfileId!, institutionId })).find((at) => at > hours(48))!;

  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let locked!: (pid: number) => void;
  const holderPid = new Promise<number>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await tx.select({ id: tutorProfile.id }).from(tutorProfile).where(eq(tutorProfile.id, tutor.tutorProfileId!)).for("update");
    const [{ pid }] = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
    locked(pid);
    await released;
  });

  try {
    const pid = await holderPid;
    const booking = bookSession({ actor: student, engagementId: id, slotStartsAt: slot }).then(
      () => null,
      (error: unknown) => error,
    );
    let blocked = false;
    for (let tries = 0; tries < 500 && !blocked; tries += 1) {
      const [row] = (await db.execute(
        sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`,
      )) as unknown as { n: number }[];
      blocked = row.n > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the booking read the package and is waiting on the tutor");

    const cancelling = cancelSession({ actor: student, sessionId });
    for (let tries = 0; tries < 500; tries += 1) {
      const [row] = await db.select({ status: sessionBooking.status }).from(sessionBooking).where(eq(sessionBooking.id, sessionId));
      if (row.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    const refused = await booking;
    assert.ok(refused instanceof SessionError, `the booking went through: ${String(refused)}`);
    assert.match(refused.message, /used every session|That package is closed/);
    assert.equal((await cancelling).refundedMinor, 3_500);
  } finally {
    release();
    await holder;
  }
  const sessions = await db.select({ status: sessionBooking.status }).from(sessionBooking).where(eq(sessionBooking.engagementId, id));
  assert.deepEqual(sessions, [{ status: "cancelled" }]);
  assert.equal(await statusOf(id), "refunded");
});

test("cancelling the last session of a four-pack inside 12 hours closes it as completed with only the $8.75 refund", async () => {
  const student = await person();
  const id = await pkg(student);
  for (const h of [-300, -200, -100]) await attended(id, hours(h));
  const last = await session(id, hours(3));

  const outcome = await cancelSession({ actor: student, sessionId: last });
  assert.deepEqual([outcome.keptMinor, outcome.refundedMinor, outcome.refunds.length], [2_625, 875, 1]);
  assert.equal(await statusOf(id), "completed");
  assert.deepEqual((await refunds(id)).map((r) => [r.sessionId, r.amountMinor]), [[last, 875]], "nothing was left deferred to refund on closing");
});

test("a cancel that leaves another session booked keeps the package open and still refunds now", async () => {
  const student = await person();
  const id = await pkg(student);
  for (const h of [-300, -200]) await attended(id, hours(h));
  const soon = await session(id, hours(20));
  await session(id, hours(72));

  assert.equal((await cancelSession({ actor: student, sessionId: soon })).refundedMinor, 1_750);
  assert.equal(await statusOf(id), "active");
  assert.equal(await left(id), 0);
});

test("the last session confirmed after an earlier kept cancel closes the package with nothing more to refund", async () => {
  const student = await person();
  const id = await pkg(student);
  const cancelled = await session(id, hours(20));
  await cancelSession({ actor: student, sessionId: cancelled });
  for (const h of [-300, -200]) await attended(id, hours(h));
  const last = await session(id, hours(-3), { studentConfirmedAt: new Date() });

  assert.equal((await confirmAttendance({ actor: tutor, sessionId: last })).status, "completed");
  assert.equal(await statusOf(id), "completed");
  assert.deepEqual((await refunds(id)).map((r) => [r.sessionId, r.amountMinor]), [[cancelled, 1_750]]);
});

test("a kept cancel and the confirmation of the other last session at once close the package, refunding only the cancel's share", async () => {
  for (const headStartMs of [0, 2, 4, 8]) {
    const student = await person();
    const id = await pkg(student);
    for (const h of [-300, -200]) await attended(id, hours(h));
    const confirming = await session(id, hours(-3), { studentConfirmedAt: new Date() });
    const cancelling = await session(id, hours(20));

    const results = await Promise.allSettled([
      confirmAttendance({ actor: tutor, sessionId: confirming }),
      new Promise((resolve) => setTimeout(resolve, headStartMs)).then(() => cancelSession({ actor: student, sessionId: cancelling })),
    ]);
    assert.ok(results.every((result) => result.status === "fulfilled"), String(results.map((r) => r.status === "rejected" && r.reason)));
    assert.equal(await statusOf(id), "completed", `head start ${headStartMs}ms`);
    assert.deepEqual((await refunds(id)).map((r) => [r.sessionId, r.amountMinor]), [[cancelling, 1_750]]);
  }
});

test("a kept cancel racing the term-end sweep never deadlocks, and the two refunds never pass the price", async () => {
  for (const headStartMs of [0, 1, 2, 4, 8]) {
    const student = await person();
    const id = await pkg(student);
    const sessionId = await session(id, hours(20));

    const results = await Promise.allSettled([
      db.transaction((tx) => closeWithRefund(tx, { engagementId: id, institutionId })),
      new Promise((resolve) => setTimeout(resolve, headStartMs)).then(() => cancelSession({ actor: student, sessionId })),
    ]);
    assert.equal(results[0].status, "fulfilled", `head start ${headStartMs}ms: ${results[0].status === "rejected" && results[0].reason}`);
    if (results[1].status === "rejected") assert.ok(results[1].reason instanceof SessionError, String(results[1].reason));
    const amounts = (await refunds(id)).map((r) => r.amountMinor).sort((a, b) => a - b);
    assert.deepEqual(amounts, results[1].status === "fulfilled" ? [1_750, 10_500] : [14_000], `head start ${headStartMs}ms`);
  }
});

test("ending with a session 20 hours away charges it at its tier, and the 10% fee only on the three after it", async () => {
  const student = await person();
  const id = await pkg(student, "exam_anchored", (await newTutor()).claimId);
  const soon = await session(id, hours(20));

  const [preview] = (await packagesForStudent(student)).filter((row) => row.engagementId === id);
  assert.deepEqual(
    { back: preview.ending.backMinor, tutor: preview.ending.tutorMinor, blocked: preview.ending.blocked },
    { back: 11_200, tutor: 2_800, blocked: null },
  );

  const ended = await endPackage({ actor: student, engagementId: id });
  assert.equal(ended?.refundMinor, 9_450);
  assert.equal(ended?.feeMinor, 1_050);
  assert.deepEqual(ended?.charged.map(({ keptMinor, returnedMinor }) => ({ keptMinor, returnedMinor })), [
    { keptMinor: 1_750, returnedMinor: 1_750 },
  ]);
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 14_000 },
    { type: "platform_fee", amountMinor: 175 },
    { type: "refund", amountMinor: 1_750 },
    { type: "refund", amountMinor: 9_450 },
    { type: "session_earned", amountMinor: 1_050 },
    { type: "session_earned", amountMinor: 1_750 },
    { type: "tutor_accrued", amountMinor: 1_050 },
    { type: "tutor_accrued", amountMinor: 1_575 },
  ]);
  const [row] = await db.select({ status: sessionBooking.status }).from(sessionBooking).where(eq(sessionBooking.id, soon));
  assert.equal(row.status, "cancelled");
  assert.deepEqual(await facts(student), [], "outside 12 hours it is not a late cancel");
  assert.equal(await statusOf(id), "refunded");
});

test("ending with a session 6 hours away keeps 75% of it, which is a late cancel, and 10% of the rest", async () => {
  const student = await person();
  const id = await pkg(student);
  await session(id, hours(6));

  const ended = await endPackage({ actor: student, engagementId: id });
  assert.deepEqual(
    { refund: ended?.refundMinor, fee: ended?.feeMinor, charged: ended?.charged.map((charge) => charge.returnedMinor) },
    { refund: 9_450, fee: 1_050, charged: [875] },
  );
  assert.deepEqual(await facts(student), ["late_cancelled"]);
});

test("a cancel the tutor was paid for can never be rated", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(5));
  await cancelSession({ actor: student, sessionId });

  assert.equal(await sessionRatingState(student, sessionId), null);
  await assert.rejects(rateSession({ actor: student, sessionId, stars: 5, note: null }), /Only a session that took place can be rated/);
});

async function cancelEmails(): Promise<string> {
  const lines: string[] = [];
  const logged = mock.method(console, "log", (line: unknown) => lines.push(String(line)));
  try {
    await notifyCancelledSessions(institutionId);
  } finally {
    logged.mock.restore();
  }
  return lines.join("\n");
}

test("the cancel email tells the tutor what a kept cancel pays, and tells the student what a tutor cancel sends to their card", async () => {
  const student = await person();
  const id = await pkg(student);
  const kept = await session(id, hours(20), { bookedNotifiedAt: new Date() });
  await cancelSession({ actor: student, sessionId: kept });
  await cancelSession({ actor: tutor, sessionId: await session(id, hours(5), { bookedNotifiedAt: new Date() }) });
  const [accrued] = await db
    .select({ amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .where(and(eq(ledgerEntry.sessionId, kept), eq(ledgerEntry.type, "tutor_accrued")));

  const sent = await cancelEmails();
  assert.ok([1_575, 1_663].includes(accrued.amountMinor), "half of $35, less the 10% or 5% fee");
  assert.ok(sent.includes(`That time is open again. You'll be paid $${(accrued.amountMinor / 100).toFixed(2)} for this session.`));
  assert.match(sent, /You get \$35\.00 back on your card for this session\. It can take 5 to 10 days to show\./);
  assert.doesNotMatch(sent, /back in your package/);
  assert.doesNotMatch(sent, /late cancel/i);
});

test("the cancel email for a free four-pack cancel tells the tutor the session is back in the student's package", async () => {
  const student = await person();
  const id = await pkg(student);
  await cancelSession({ actor: student, sessionId: await session(id, hours(30), { bookedNotifiedAt: new Date() }) });

  assert.match(await cancelEmails(), /That time is open again, and the session is back in .+'s package\./);
});

test("the cancel email for a free one-time cancel tells the tutor the time is open, without a package to go back to", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  await cancelSession({ actor: student, sessionId: await session(id, hours(30), { bookedNotifiedAt: new Date() }) });

  const sent = await cancelEmails();
  assert.match(sent, /That time is open again\.\n/);
  assert.doesNotMatch(sent, /back in .+'s package/);
});

test("the booking and reminder emails tell the student what a cancel gives back from when they are sent", () => {
  const email = (scheduledAt: Date, recipient: "student" | "tutor" = "student") => ({
    to: "x@example.test",
    name: "Sam",
    otherPartyName: "Ada",
    courseLabel: "CXL 101",
    scheduledAt,
    freeUntil: new Date(scheduledAt.getTime() - 12 * 3_600_000),
    recipient,
    location: "Library",
    studentNote: null,
    sessionsPurchased: 4,
  });

  assert.match(
    sessionBooked(email(hours(72))).text,
    /Cancel before .+ and the session goes back in your package\. After that you get 50% of it back on your card, and 25% inside 12 hours\./,
  );
  assert.match(sessionTomorrow(email(hours(20))).text, /Can't make it\? Cancel before .+ and you get 50% of the session back on your card\. After that, 25%\./);
  assert.match(sessionBooked(email(hours(11))).text, /Cancelling now gets you 25% of the session back on your card\./);
  assert.doesNotMatch(sessionBooked(email(hours(72))).text, /late cancel/);
  assert.match(sessionBooked(email(hours(72), "tutor")).text, /Cancelling is free until/);

  const single = (scheduledAt: Date) => ({ ...email(scheduledAt), sessionsPurchased: 1 });
  assert.match(
    sessionBooked(single(hours(72))).text,
    /Cancel before .+ and you get all of it back on your card\. After that you get 50% of it back on your card, and 25% inside 12 hours\./,
  );
  assert.doesNotMatch(sessionBooked(single(hours(72))).text, /back in your package/);
  assert.match(sessionTomorrow(single(hours(20))).text, /Can't make it\? Cancel before .+ and you get 50% of the session back on your card\. After that, 25%\./);
});

test("the ledger keeps its money invariants across every cancel above", async () => {
  await assertMoneyInvariants(institutionId);
});
