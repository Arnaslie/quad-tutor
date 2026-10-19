import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";

import { eq, inArray, sql } from "drizzle-orm";

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

async function pkg(student: Actor, kind: "exam_anchored" | "top_up" = "exam_anchored"): Promise<string> {
  const single = kind === "top_up";
  const [row] = await db
    .insert(engagement)
    .values({
      institutionId,
      studentProfileId: student.studentProfileId,
      tutorCourseId,
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

  const base = await person();
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tutorProfileId: profile.id, institutionId, weekday, startMinute: 0, endMinute: 24 * 60 })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId, courseId, takenTermId: termId, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  tutor = { ...base, tutorProfileId: profile.id };
  tutorCourseId = claim.id;
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

test("a student cancel of a four-pack session 24 hours or more ahead moves no money and the session goes back in the package", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(30));

  assert.deepEqual(await cancelSession({ actor: student, sessionId }), { late: false, keptMinor: 0, returnedMinor: 3_500, currency: "usd", refund: null });
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 14_000 }]);
  assert.equal(await left(id), 4);
  assert.deepEqual(await facts(student), []);
});

test("a student cancel 12 to 24 hours ahead of a $35 session pays the tutor half, and the other half refunds when the package ends", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(20));

  assert.deepEqual(await cancelSession({ actor: student, sessionId }), { late: false, keptMinor: 1_750, returnedMinor: 1_750, currency: "usd", refund: null });
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 14_000 },
    { type: "platform_fee", amountMinor: 175 },
    { type: "session_earned", amountMinor: 1_750 },
    { type: "tutor_accrued", amountMinor: 1_575 },
  ]);
  assert.equal(await left(id), 3, "the cancelled session is used");
  assert.deepEqual(await facts(student), [], "outside 12 hours it is not a late cancel");

  const [preview] = (await packagesForStudent(student)).filter((row) => row.engagementId === id);
  assert.equal(preview.ending.refundMinor, 12_250);
  assert.equal(preview.sessionsRemaining, 3);
  assert.equal((await endPackage({ actor: student, engagementId: id }))?.refundMinor, 12_250);
  assert.equal(await statusOf(id), "refunded", "nothing was attended");
});

test("a student cancel inside 12 hours pays the tutor three quarters and is a late cancel", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(5));

  assert.deepEqual(await cancelSession({ actor: student, sessionId }), { late: true, keptMinor: 2_625, returnedMinor: 875, currency: "usd", refund: null });
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 14_000 },
    { type: "platform_fee", amountMinor: 262 },
    { type: "session_earned", amountMinor: 2_625 },
    { type: "tutor_accrued", amountMinor: 2_363 },
  ]);
  assert.equal(await left(id), 3);
  assert.deepEqual(await facts(student), ["late_cancelled"]);
});

test("a tutor cancel at the last minute costs the student nothing and the session goes back in the package", async () => {
  const student = await person();
  const id = await pkg(student);
  const sessionId = await session(id, hours(1));

  assert.deepEqual(await cancelSession({ actor: tutor, sessionId }), { late: true, keptMinor: 0, returnedMinor: 3_500, currency: "usd", refund: null });
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 14_000 }]);
  assert.equal(await left(id), 4);
  assert.deepEqual(await facts(student), []);
});

test("cancelling the only session of a single inside 24 hours closes it and refunds the rest at once", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(20));
  assert.equal((await sessionDetail({ actor: student, sessionId })).lastInPackage, true, "the form says the money comes back now");

  const outcome = await cancelSession({ actor: student, sessionId });
  assert.equal(outcome.keptMinor, 1_750);
  assert.equal(outcome.refund?.refundMinor, 1_750);
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

  assert.deepEqual(await cancelSession({ actor: student, sessionId }), {
    late: false,
    keptMinor: 0,
    returnedMinor: 3_500,
    currency: "usd",
    refund: { engagementId: id, studentProfileId: student.studentProfileId, sessionsPurchased: 1, sessionsDelivered: 0, refundMinor: 3_500, currency: "usd" },
  });
  assert.equal(await statusOf(id), "refunded");
  assert.deepEqual(await ledger(id), [
    { type: "package_purchase", amountMinor: 3_500 },
    { type: "refund", amountMinor: 3_500 },
  ]);
  assert.deepEqual(await facts(student), []);
  assert.equal((await sessionDetail({ actor: student, sessionId })).sessionsRemaining, 0, "a closed package has nothing left to book");
  assert.equal(await endPackage({ actor: student, engagementId: id }), null, "a second close finds nothing to refund");
});

test("a student cancel of a one-time session inside 12 hours keeps 75% and refunds $8.75 at once", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(5));

  const outcome = await cancelSession({ actor: student, sessionId });
  assert.deepEqual([outcome.late, outcome.keptMinor, outcome.refund?.refundMinor], [true, 2_625, 875]);
  assert.equal(await statusOf(id), "refunded");
  assert.deepEqual((await ledger(id)).filter((row) => row.type === "refund"), [{ type: "refund", amountMinor: 875 }]);
  assert.deepEqual(await facts(student), ["late_cancelled"]);
});

test("a tutor cancel of a one-time session refunds nothing and the session goes back in the package", async () => {
  const student = await person();
  const id = await pkg(student, "top_up");
  const sessionId = await session(id, hours(30));

  assert.deepEqual(await cancelSession({ actor: tutor, sessionId }), { late: false, keptMinor: 0, returnedMinor: 3_500, currency: "usd", refund: null });
  assert.equal(await statusOf(id), "active");
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 3_500 }]);
  assert.equal(await left(id, 1), 1);
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
      winners.add(cancel.status === "fulfilled" && cancel.value.refund ? "cancel" : "sweep");
      assert.deepEqual((await ledger(id)).filter((row) => row.type === "refund"), [{ type: "refund", amountMinor: 3_500 }], label);
      assert.equal(await statusOf(id), "refunded", label);
    }
  }
  assert.deepEqual([...winners].sort(), ["cancel", "sweep"], "both orders were exercised");
});

test("a booking that read a one-time package as open before a free cancel closed it is refused", async () => {
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

    assert.equal((await cancelSession({ actor: student, sessionId })).refund?.refundMinor, 3_500);
    release();
    const refused = await booking;
    assert.ok(refused instanceof SessionError, `the booking went through: ${String(refused)}`);
    assert.match(refused.message, /That package is closed/);
  } finally {
    release();
    await holder;
  }
  const sessions = await db.select({ status: sessionBooking.status }).from(sessionBooking).where(eq(sessionBooking.engagementId, id));
  assert.deepEqual(sessions, [{ status: "cancelled" }]);
});

test("cancelling the last session of a four-pack inside 12 hours closes it as completed and refunds $8.75", async () => {
  const student = await person();
  const id = await pkg(student);
  for (const h of [-300, -200, -100]) await attended(id, hours(h));
  const last = await session(id, hours(3));

  const outcome = await cancelSession({ actor: student, sessionId: last });
  assert.deepEqual([outcome.keptMinor, outcome.refund?.refundMinor], [2_625, 875]);
  assert.equal(await statusOf(id), "completed");
  assert.deepEqual((await ledger(id)).filter((row) => row.type === "refund"), [{ type: "refund", amountMinor: 875 }]);
});

test("a cancel that leaves another session booked keeps the package open", async () => {
  const student = await person();
  const id = await pkg(student);
  for (const h of [-300, -200]) await attended(id, hours(h));
  const soon = await session(id, hours(20));
  await session(id, hours(72));
  assert.equal((await sessionDetail({ actor: student, sessionId: soon })).lastInPackage, false, "the form says it waits for the package to end");

  assert.equal((await cancelSession({ actor: student, sessionId: soon })).refund, null);
  assert.equal(await statusOf(id), "active");
  assert.equal(await left(id), 0);
});

test("the last session confirmed after an earlier kept cancel closes the package and refunds what that cancel left", async () => {
  const student = await person();
  const id = await pkg(student);
  await cancelSession({ actor: student, sessionId: await session(id, hours(20)) });
  for (const h of [-300, -200]) await attended(id, hours(h));
  const last = await session(id, hours(-3), { studentConfirmedAt: new Date() });

  assert.equal((await confirmAttendance({ actor: tutor, sessionId: last })).status, "completed");
  assert.equal(await statusOf(id), "completed");
  assert.deepEqual((await ledger(id)).filter((row) => row.type === "refund"), [{ type: "refund", amountMinor: 1_750 }]);
});

test("a kept cancel and the confirmation of the other last session at once close the package with one refund", async () => {
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
    assert.deepEqual((await ledger(id)).filter((row) => row.type === "refund"), [{ type: "refund", amountMinor: 1_750 }]);
  }
});

test("a kept cancel racing the term-end sweep never deadlocks and leaves one refund", async () => {
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
    const refunds = (await ledger(id)).filter((row) => row.type === "refund");
    assert.deepEqual(refunds, [{ type: "refund", amountMinor: results[1].status === "fulfilled" ? 12_250 : 14_000 }], `head start ${headStartMs}ms`);
  }
});

test("ending the package is refused while a session is inside 24 hours, so the end never dodges the cancel price", async () => {
  const student = await person();
  const id = await pkg(student);
  await session(id, hours(20));

  await assert.rejects(endPackage({ actor: student, engagementId: id }), /less than 24 hours away\. Cancel it first/);
  assert.equal(await statusOf(id), "active");
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 14_000 }]);
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

test("the cancel email tells the tutor what a kept cancel pays, and tells the student how to get unused sessions back", async () => {
  const student = await person();
  const id = await pkg(student);
  await cancelSession({ actor: student, sessionId: await session(id, hours(20), { bookedNotifiedAt: new Date() }) });
  await cancelSession({ actor: tutor, sessionId: await session(id, hours(5), { bookedNotifiedAt: new Date() }) });

  const sent = await cancelEmails();
  assert.match(sent, /That time is open again\. You'll be paid \$15\.75 for this session\./);
  assert.match(sent, /The session is back in your package\. Book another time whenever suits you, or end the package to get the sessions you don't use refunded\./);
  assert.doesNotMatch(sent, /late cancel/i);
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
    /Cancel before .+ and the session goes back in your package\. After that you get 50% of it back, and 25% inside 12 hours\./,
  );
  assert.match(sessionTomorrow(email(hours(20))).text, /Can't make it\? Cancel before .+ and you get 50% of the session back\. After that, 25%\./);
  assert.match(sessionBooked(email(hours(11))).text, /Cancelling now gets you 25% of the session back\./);
  assert.doesNotMatch(sessionBooked(email(hours(72))).text, /late cancel/);
  assert.match(sessionBooked(email(hours(72), "tutor")).text, /Cancelling is free until/);

  const single = (scheduledAt: Date) => ({ ...email(scheduledAt), sessionsPurchased: 1 });
  assert.match(
    sessionBooked(single(hours(72))).text,
    /Cancel before .+ and you get all of it back on your card\. After that you get 50% of it back, and 25% inside 12 hours\./,
  );
  assert.doesNotMatch(sessionBooked(single(hours(72))).text, /back in your package/);
  assert.match(sessionTomorrow(single(hours(20))).text, /Can't make it\? Cancel before .+ and you get 50% of the session back\. After that, 25%\./);
});

test("the ledger keeps its money invariants across every cancel above", async () => {
  await assertMoneyInvariants(institutionId);
});
