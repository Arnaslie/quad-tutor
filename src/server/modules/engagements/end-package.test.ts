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
  messageThread,
  reliabilityEvent,
  sessionBooking,
  studentProfile,
  term,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { notifyCancelledSessions } from "@/server/modules/notifications/dispatch";
import { refreshScores } from "@/server/modules/scoring/stats";

import { SessionError } from "./access";
import { confirmAttendance } from "./confirmation";
import { packagesForStudent } from "./reads";
import { bookSession, slotsForEngagement } from "./scheduling";
import { EndPackageError, closeWithRefund, endPackage, runTermEndRefunds } from "./termEnd";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made = { institutions: [] as string[], users: [] as string[] };

type Campus = { institutionId: string; termId: string; courseId: string; offeringId: string };
let home: Campus;
let away: Campus;
let tutor: TutorActor;
let tutorCourseId: string;
let endedOfferingId: string;

const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

let people = 0;
async function person(institutionId: string): Promise<Actor> {
  const id = `test_end_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  made.users.push(id);
  const [profile] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId, studentProfileId: profile.id, tutorProfileId: null };
}

async function campus(slug: string): Promise<Campus> {
  const [inst] = await db
    .insert(institution)
    .values({ name: `Test ${slug}`, slug: `end-${slug}-${run}`, emailDomain: `end-${slug}-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  made.institutions.push(inst.id);
  const today = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const [termRow] = await db.insert(term).values({ institutionId: inst.id, name: "Now", startsOn: today(-30), endsOn: today(60) }).returning({ id: term.id });
  const [courseRow] = await db.insert(course).values({ institutionId: inst.id, title: "End 101", department: "TEST" }).returning({ id: course.id });
  await db.insert(courseCodeAlias).values({ institutionId: inst.id, courseId: courseRow.id, code: `END ${slug} ${run}` });
  const [offering] = await db
    .insert(courseOffering)
    .values({ institutionId: inst.id, courseId: courseRow.id, termId: termRow.id, section: "001" })
    .returning({ id: courseOffering.id });
  return { institutionId: inst.id, termId: termRow.id, courseId: courseRow.id, offeringId: offering.id };
}

async function tutorWithClaim(): Promise<{ actor: TutorActor; claimId: string }> {
  const base = await person(home.institutionId);
  const [profile] = await db.insert(tutorProfile).values({ userId: base.userId, institutionId: home.institutionId }).returning({ id: tutorProfile.id });
  await db.insert(tutorAvailability).values(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tutorProfileId: profile.id, institutionId: home.institutionId, weekday, startMinute: 0, endMinute: 24 * 60 })),
  );
  const [claim] = await db
    .insert(tutorCourse)
    .values({ tutorProfileId: profile.id, institutionId: home.institutionId, courseId: home.courseId, takenTermId: home.termId, gradeEarned: "A", status: "active" })
    .returning({ id: tutorCourse.id });
  return { actor: { ...base, tutorProfileId: profile.id }, claimId: claim.id };
}

async function pkg(
  student: Actor,
  options: { kind?: "exam_anchored" | "through_final"; claimId?: string; offeringId?: string } = {},
): Promise<string> {
  const through = options.kind === "through_final";
  const [row] = await db
    .insert(engagement)
    .values({
      institutionId: home.institutionId,
      studentProfileId: student.studentProfileId,
      tutorCourseId: options.claimId ?? tutorCourseId,
      courseOfferingId: options.offeringId ?? home.offeringId,
      kind: options.kind ?? "exam_anchored",
      sessionsPurchased: through ? 8 : 4,
      pricePaidMinor: through ? 25_200 : 14_000,
    })
    .returning({ id: engagement.id, pricePaidMinor: engagement.pricePaidMinor });
  await db.insert(ledgerEntry).values({ engagementId: row.id, institutionId: home.institutionId, type: "package_purchase", amountMinor: row.pricePaidMinor });
  return row.id;
}

async function session(
  engagementId: string,
  at: Date,
  fields: Partial<typeof sessionBooking.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(sessionBooking)
    .values({ engagementId, institutionId: home.institutionId, scheduledAt: at, confirmationWindowEndsAt: new Date(at.getTime() + 25 * 3_600_000), ...fields })
    .returning({ id: sessionBooking.id });
  return row.id;
}

async function ledger(engagementId: string) {
  return db
    .select({ type: ledgerEntry.type, amountMinor: ledgerEntry.amountMinor })
    .from(ledgerEntry)
    .where(eq(ledgerEntry.engagementId, engagementId))
    .orderBy(ledgerEntry.type);
}

async function statusOf(engagementId: string) {
  const [row] = await db.select({ status: engagement.status }).from(engagement).where(eq(engagement.id, engagementId));
  return row.status;
}

async function facts(student: Actor) {
  return db.select({ type: reliabilityEvent.type }).from(reliabilityEvent).where(eq(reliabilityEvent.userId, student.userId));
}

async function scheduledLeft(engagementId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionBooking)
    .where(and(eq(sessionBooking.engagementId, engagementId), eq(sessionBooking.status, "scheduled")));
  return n;
}

const sweep = (engagementId: string) =>
  db.transaction((tx) => closeWithRefund(tx, { engagementId, institutionId: home.institutionId }));

before(async () => {
  home = await campus("home");
  away = await campus("away");
  ({ actor: tutor, claimId: tutorCourseId } = await tutorWithClaim());
  const [ended] = await db.insert(term).values({ institutionId: home.institutionId, name: "Last", startsOn: "2026-01-10", endsOn: "2026-05-10" }).returning({ id: term.id });
  const [offering] = await db
    .insert(courseOffering)
    .values({ institutionId: home.institutionId, courseId: home.courseId, termId: ended.id, section: "002" })
    .returning({ id: courseOffering.id });
  endedOfferingId = offering.id;
});

after(async () => {
  const institutions = made.institutions;
  const engagements = (await db.select({ id: engagement.id }).from(engagement).where(inArray(engagement.institutionId, institutions))).map((row) => row.id);
  await db.delete(reliabilityEvent).where(inArray(reliabilityEvent.institutionId, institutions));
  if (engagements.length) {
    await db.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagements));
    await db.delete(sessionBooking).where(inArray(sessionBooking.engagementId, engagements));
    await db.delete(engagement).where(inArray(engagement.id, engagements));
  }
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

test("ending refunds what the sweep would for the same state, as one refund row and nothing else", async () => {
  const ended = await person(home.institutionId);
  const swept = await person(home.institutionId);
  const mine = await pkg(ended, { kind: "through_final" });
  const theirs = await pkg(swept, { kind: "through_final" });
  for (const id of [mine, theirs]) {
    for (const h of [-300, -200, -100]) await session(id, hours(h), { status: "completed", resolution: "both_confirmed" });
    await session(id, hours(48));
  }

  const viaEnd = await endPackage({ actor: ended, engagementId: mine });
  const viaSweep = await sweep(theirs);
  assert.equal(viaEnd?.refundMinor, 25_200 - 3 * 3_150, "floor rounding: through the final at $31.50 refunds to the cent");
  assert.equal(viaEnd?.refundMinor, viaSweep?.refundMinor);
  assert.deepEqual(await ledger(mine), [
    { type: "package_purchase", amountMinor: 25_200 },
    { type: "refund", amountMinor: 15_750 },
  ]);
  assert.deepEqual(await facts(ended), []);
});

test("refused at 11h before a session, allowed at 13h; the future booking is cancelled as the student's on-time cancel", async () => {
  const student = await person(home.institutionId);
  const id = await pkg(student);
  const soon = await session(id, hours(11), { bookedNotifiedAt: new Date() });

  await assert.rejects(endPackage({ actor: student, engagementId: id }), (error: unknown) => {
    assert.ok(error instanceof EndPackageError);
    assert.equal(error.block.reason, "late_cancel_window");
    return true;
  });
  const [preview] = (await packagesForStudent(student)).filter((row) => row.engagementId === id);
  assert.equal(preview.ending.blocked?.reason, "late_cancel_window");
  assert.equal(await statusOf(id), "active");

  await db.update(sessionBooking).set({ scheduledAt: hours(13) }).where(eq(sessionBooking.id, soon));
  const [ready] = (await packagesForStudent(student)).filter((row) => row.engagementId === id);
  assert.deepEqual(ready.ending, { refundMinor: 14_000, cancels: [ready.ending.cancels[0]], blocked: null });

  const refund = await endPackage({ actor: student, engagementId: id });
  assert.equal(refund?.refundMinor, 14_000);
  const [cancelled] = await db
    .select({ status: sessionBooking.status, cancelledAt: sessionBooking.cancelledAt, by: sessionBooking.cancelledByUserId })
    .from(sessionBooking)
    .where(eq(sessionBooking.id, soon));
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.by, student.userId);
  assert.deepEqual(await facts(student), [], "ending writes no reliability fact");

  assert.ok((await notifyCancelledSessions(home.institutionId)) >= 1, "the tutor gets the existing cancel email");
  const [marked] = await db.select({ at: sessionBooking.cancelNotifiedAt }).from(sessionBooking).where(eq(sessionBooking.id, soon));
  assert.ok(marked.at);
});

test("refused while a session is past its start and unanswered, or disputed", async () => {
  const student = await person(home.institutionId);
  const id = await pkg(student);
  const started = await session(id, hours(-2));
  await assert.rejects(endPackage({ actor: student, engagementId: id }), /still being confirmed/);

  await db.update(sessionBooking).set({ status: "disputed", resolution: "disputed" }).where(eq(sessionBooking.id, started));
  await assert.rejects(endPackage({ actor: student, engagementId: id }), /under review/);
  assert.equal(await statusOf(id), "active");
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 14_000 }]);
});

test("nothing delivered ends refunded, one delivered ends completed, and only the first is not a renewal trial", async () => {
  const { claimId } = await tutorWithClaim();
  const empty = await person(home.institutionId);
  const emptyId = await pkg(empty, { claimId });
  const used = await person(home.institutionId);
  const usedId = await pkg(used, { claimId });
  await session(usedId, hours(-100), { status: "completed", resolution: "both_confirmed" });

  assert.equal((await endPackage({ actor: empty, engagementId: emptyId }))?.refundMinor, 14_000);
  assert.equal((await endPackage({ actor: used, engagementId: usedId }))?.refundMinor, 10_500);
  assert.equal(await statusOf(emptyId), "refunded");
  assert.equal(await statusOf(usedId), "completed");

  await refreshScores(home.institutionId);
  const [scored] = await db.select({ trials: tutorCourse.renewalTrialCount }).from(tutorCourse).where(eq(tutorCourse.id, claimId));
  assert.equal(scored.trials, 1, "the delivered one is a failed trial; the empty one never ran");
});

test("a second end is a no-op, and only the package's own student on its own campus can end it", async () => {
  const student = await person(home.institutionId);
  const id = await pkg(student);
  const stranger = await person(home.institutionId);
  const elsewhere = await person(away.institutionId);

  await assert.rejects(endPackage({ actor: stranger, engagementId: id }), /not yours/);
  await assert.rejects(endPackage({ actor: { ...elsewhere, studentProfileId: student.studentProfileId }, engagementId: id }), /does not exist/);
  await assert.rejects(endPackage({ actor: tutor, engagementId: id }), SessionError);

  assert.ok(await endPackage({ actor: student, engagementId: id }));
  assert.equal(await endPackage({ actor: student, engagementId: id }), null);
  assert.equal((await ledger(id)).filter((row) => row.type === "refund").length, 1);
});

test("a booking in flight when the end arrives is cancelled by the end, not left on a closed package", async () => {
  const student = await person(home.institutionId);
  const id = await pkg(student);

  let ending: Promise<unknown> = Promise.resolve();
  await db.transaction(async (tx) => {
    await tx.select({ id: engagement.id }).from(engagement).where(eq(engagement.id, id)).for("key share");
    ending = endPackage({ actor: student, engagementId: id }).then((value) => value, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await tx.insert(sessionBooking).values({ engagementId: id, institutionId: home.institutionId, scheduledAt: hours(72) });
  });

  assert.ok(!((await ending) instanceof Error), String(await ending));
  assert.equal(await statusOf(id), "refunded");
  assert.equal(await scheduledLeft(id), 0);
});

test("ending and booking at once: never a live session on a closed package", async () => {
  for (const headStartMs of [0, 2, 4, 8, 12]) {
    const student = await person(home.institutionId);
    const id = await pkg(student);
    const slot = (await slotsForEngagement({ actor: student, engagementId: id })).find((at) => at > hours(14));
    assert.ok(slot);

    const results = await Promise.allSettled([
      endPackage({ actor: student, engagementId: id }),
      new Promise((resolve) => setTimeout(resolve, headStartMs)).then(() => bookSession({ actor: student, engagementId: id, slotStartsAt: slot })),
    ]);
    assert.equal(results[0].status, "fulfilled", `head start ${headStartMs}ms`);
    if (results[1].status === "rejected") assert.ok(results[1].reason instanceof SessionError);
    assert.equal(await scheduledLeft(id), 0, `head start ${headStartMs}ms`);
    assert.equal((await ledger(id)).filter((row) => row.type === "refund").length, 1);
  }
});

test("ending and the term-end sweep at once write one refund row", async () => {
  for (let round = 0; round < 8; round += 1) {
    const student = await person(home.institutionId);
    const id = await pkg(student);
    await session(id, hours(-100), { status: "completed", resolution: "both_confirmed" });
    await session(id, hours(48));

    const results = await Promise.allSettled([endPackage({ actor: student, engagementId: id }), sweep(id)]);
    assert.ok(results.every((result) => result.status === "fulfilled"), String(results.map((r) => r.status === "rejected" && r.reason)));
    assert.deepEqual((await ledger(id)).filter((row) => row.type === "refund"), [{ type: "refund", amountMinor: 10_500 }]);
    assert.equal(await statusOf(id), "completed");
  }
});

test("ending while the last session is being confirmed: the confirmation lands, nothing is refunded", async () => {
  for (const headStartMs of [0, 2, 4, 8]) {
    const student = await person(home.institutionId);
    const id = await pkg(student);
    await db.update(engagement).set({ sessionsPurchased: 1, pricePaidMinor: 3_500 }).where(eq(engagement.id, id));
    const last = await session(id, hours(-2), { studentConfirmedAt: new Date() });

    const results = await Promise.allSettled([
      new Promise((resolve) => setTimeout(resolve, headStartMs)).then(() => endPackage({ actor: student, engagementId: id })),
      confirmAttendance({ actor: tutor, sessionId: last }),
    ]);
    assert.equal(results[1].status, "fulfilled", String(results[1].status === "rejected" && results[1].reason));
    if (results[0].status === "fulfilled") assert.equal(results[0].value, null);
    else assert.ok(results[0].reason instanceof EndPackageError, String(results[0].reason));

    assert.equal(await statusOf(id), "completed");
    const rows = await ledger(id);
    assert.equal(rows.filter((row) => row.type === "refund").length, 0);
    assert.equal(rows.filter((row) => row.type === "session_earned").length, 1);
  }
});

test("the sweep holds a package with an unanswered past session and refunds it once the session settles", async () => {
  const student = await person(home.institutionId);
  const id = await pkg(student, { offeringId: endedOfferingId });
  const past = await session(id, hours(-3), { studentConfirmedAt: new Date() });
  const future = await session(id, hours(5));

  assert.deepEqual((await runTermEndRefunds(home.institutionId)).held, 1);
  assert.equal(await statusOf(id), "active");
  assert.deepEqual(await ledger(id), [{ type: "package_purchase", amountMinor: 14_000 }]);

  await confirmAttendance({ actor: tutor, sessionId: past });
  const { refunds, held } = await runTermEndRefunds(home.institutionId);
  assert.equal(held, 0);
  assert.deepEqual(refunds.map((row) => [row.engagementId, row.refundMinor]), [[id, 10_500]]);
  assert.equal(await statusOf(id), "completed");
  const [cancelled] = await db.select({ status: sessionBooking.status, by: sessionBooking.cancelledByUserId }).from(sessionBooking).where(eq(sessionBooking.id, future));
  assert.deepEqual(cancelled, { status: "cancelled", by: null }, "a future session at term end is cancelled even inside 12h, with no canceller");
  assert.deepEqual(await facts(student), [{ type: "attended" }]);
});

test("the sweep holds a package while a session is disputed", async () => {
  const student = await person(home.institutionId);
  const id = await pkg(student);
  await session(id, hours(-100), { status: "disputed", resolution: "disputed" });
  await assert.rejects(sweep(id), EndPackageError);
  assert.equal(await statusOf(id), "active");
  assert.equal((await ledger(id)).filter((row) => row.type === "refund").length, 0);
});

test("the sweep racing a confirmation of the last session: no deadlock, the session is paid, nothing refunded", async () => {
  for (const headStartMs of [0, 2, 4, 8]) {
    const student = await person(home.institutionId);
    const id = await pkg(student);
    await db.update(engagement).set({ sessionsPurchased: 1, pricePaidMinor: 3_500 }).where(eq(engagement.id, id));
    const last = await session(id, hours(-2), { studentConfirmedAt: new Date() });

    const results = await Promise.allSettled([
      new Promise((resolve) => setTimeout(resolve, headStartMs)).then(() => sweep(id)),
      confirmAttendance({ actor: tutor, sessionId: last }),
    ]);
    assert.equal(results[1].status, "fulfilled", String(results[1].status === "rejected" && results[1].reason));
    if (results[0].status === "fulfilled") assert.equal(results[0].value, null);
    else assert.ok(results[0].reason instanceof EndPackageError, String(results[0].reason));

    assert.equal(await statusOf(id), "completed");
    const rows = await ledger(id);
    assert.equal(rows.filter((row) => row.type === "refund").length, 0);
    assert.equal(rows.filter((row) => row.type === "session_earned").length, 1);
  }
});
