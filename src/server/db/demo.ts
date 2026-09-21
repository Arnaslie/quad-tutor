import { and, eq, inArray, isNotNull, isNull, like, notInArray, sql } from "drizzle-orm";

import { db } from "./index";
import {
  courseCodeAlias,
  courseOffering,
  engagement,
  ledgerEntry,
  matchRequest,
  reliabilityEvent,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "./schema";

import { balanceFor } from "@/server/modules/billing/ledger";
import { formatMinor } from "@/server/modules/billing/pricing";
import { upcomingExams } from "@/server/modules/catalog/courses";
import {
  confirmAttendance,
  denyAttendance,
  releaseLapsedConfirmations,
} from "@/server/modules/engagements/confirmation";
import {
  confirmationDeadline,
  purchasePackage,
  slotsForRequest,
} from "@/server/modules/engagements/purchase";
import {
  sessionBoardForStudent,
  sessionBoardForTutor,
  type SessionBoard,
  type SessionListItem,
} from "@/server/modules/engagements/reads";
import { bookSession, slotsForEngagement } from "@/server/modules/engagements/scheduling";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { acceptRequest, requestTutors } from "@/server/modules/matching/requests";

const MARKER = "db:demo";
const LOCATION_NOTE = `Gorgas Library, 2nd floor [${MARKER}]`;

const STUDENT = "owen.drake@crimson.ua.edu";
const ACCEPTING_TUTOR = "jordan.ellis@crimson.ua.edu";

const ALSO_ASKED = ["sofia.marek@crimson.ua.edu", "caleb.nguyen@crimson.ua.edu"];

const COURSE_CODE = "CH 101";
const SECTION = "001";

const SECOND_COURSE_CODE = "ST 260";
const SECOND_SECTION = "001";
const SECOND_TUTOR = "priyanka.shah@crimson.ua.edu";

async function actorFor(email: string): Promise<Actor> {
  const rows = await db
    .select({
      userId: user.id,
      name: user.name,
      email: user.email,
      institutionId: studentProfile.institutionId,
      studentProfileId: studentProfile.id,
      tutorProfileId: tutorProfile.id,
    })
    .from(user)
    .innerJoin(studentProfile, eq(studentProfile.userId, user.id))
    .leftJoin(tutorProfile, eq(tutorProfile.userId, user.id))
    .where(eq(user.email, email))
    .limit(1);

  const actor = rows.at(0);
  if (!actor) throw new Error(`no seeded user ${email} — run npm run db:seed first`);
  return actor;
}

async function tutorActorFor(email: string): Promise<TutorActor> {
  const actor = await actorFor(email);
  if (!actor.tutorProfileId) throw new Error(`${email} has no tutor profile`);
  return actor as TutorActor;
}

type Target = {
  courseOfferingId: string;

  tutorCourseIds: string[];
  accepterTutorCourseId: string;
};

async function resolveTarget(cast: {
  code: string;
  section: string;

  tutors: string[];
}): Promise<Target> {
  const offerings = await db
    .select({ id: courseOffering.id, courseId: courseOffering.courseId })
    .from(courseOffering)
    .innerJoin(
      courseCodeAlias,
      and(
        eq(courseCodeAlias.courseId, courseOffering.courseId),
        isNull(courseCodeAlias.validToTermId),
      ),
    )
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(courseCodeAlias.code, cast.code),
        eq(courseOffering.section, cast.section),
        sql`current_date between ${term.startsOn} and ${term.endsOn}`,
      ),
    )
    .limit(1);

  const offering = offerings.at(0);
  if (!offering) throw new Error(`no ${cast.code}-${cast.section} offering — seed first`);

  const emails = cast.tutors;
  const rows = await db
    .select({ id: tutorCourse.id, email: user.email })
    .from(tutorCourse)
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .where(
      and(
        eq(tutorCourse.courseId, offering.courseId),
        eq(tutorCourse.status, "active"),
        inArray(user.email, emails),
      ),
    );

  const byEmail = new Map(rows.map((row) => [row.email, row.id]));
  const missing = emails.filter((email) => !byEmail.has(email));
  if (missing.length > 0) {
    throw new Error(`not tutoring ${cast.code}: ${missing.join(", ")} — seed first`);
  }

  return {
    courseOfferingId: offering.id,
    tutorCourseIds: emails.map((email) => byEmail.get(email)!),
    accepterTutorCourseId: byEmail.get(emails[0])!,
  };
}

async function cleanup(
  actor: Actor,
  targets: Target[],
): Promise<{ engagements: number; requests: number }> {
  const offeringIds = targets.map((target) => target.courseOfferingId);
  const tutorCourseIds = targets.flatMap((target) => target.tutorCourseIds);

  const ours = and(
    eq(matchRequest.studentProfileId, actor.studentProfileId),
    inArray(matchRequest.courseOfferingId, offeringIds),
    inArray(matchRequest.tutorCourseId, tutorCourseIds),
  );

  return db.transaction(async (tx) => {
    const marked = await tx
      .selectDistinct({ id: sessionBooking.engagementId })
      .from(sessionBooking)
      .where(like(sessionBooking.locationNote, `%${MARKER}%`));

    const fromRequests = await tx
      .select({ id: engagement.id })
      .from(engagement)
      .innerJoin(matchRequest, eq(matchRequest.id, engagement.matchRequestId))
      .where(ours);

    const engagementIds = [
      ...new Set([...marked, ...fromRequests].map((row) => row.id)),
    ];

    if (engagementIds.length > 0) {
      const sessions = await tx
        .select({ id: sessionBooking.id })
        .from(sessionBooking)
        .where(inArray(sessionBooking.engagementId, engagementIds));
      const sessionIds = sessions.map((row) => row.id);

      const requests = await tx
        .select({ id: engagement.matchRequestId })
        .from(engagement)
        .where(
          and(inArray(engagement.id, engagementIds), isNotNull(engagement.matchRequestId)),
        );

      if (sessionIds.length > 0) {
        await tx
          .delete(reliabilityEvent)
          .where(inArray(reliabilityEvent.sessionId, sessionIds));
      }
      await tx.delete(ledgerEntry).where(inArray(ledgerEntry.engagementId, engagementIds));
      await tx
        .delete(sessionBooking)
        .where(inArray(sessionBooking.engagementId, engagementIds));
      await tx.delete(engagement).where(inArray(engagement.id, engagementIds));

      const requestIds = requests
        .map((row) => row.id)
        .filter((id): id is string => id !== null);
      if (requestIds.length > 0) {
        await tx.delete(matchRequest).where(inArray(matchRequest.id, requestIds));
      }
    }

    const attached = await tx
      .select({ id: engagement.matchRequestId })
      .from(engagement)
      .where(isNotNull(engagement.matchRequestId));

    const attachedIds = attached
      .map((row) => row.id)
      .filter((id): id is string => id !== null);

    const stray = await tx
      .delete(matchRequest)
      .where(
        and(ours, attachedIds.length > 0 ? notInArray(matchRequest.id, attachedIds) : undefined),
      )
      .returning({ id: matchRequest.id });

    return { engagements: engagementIds.length, requests: stray.length };
  });
}

async function moveIntoPast(params: {
  engagementId: string;
  sessionId: string;
  hoursAgo: number;
}): Promise<void> {
  const scheduledAt = new Date(Date.now() - params.hoursAgo * 60 * 60 * 1000);

  await db
    .update(sessionBooking)
    .set({
      scheduledAt,
      confirmationWindowEndsAt: confirmationDeadline(scheduledAt),
    })
    .where(
      and(
        eq(sessionBooking.id, params.sessionId),
        eq(sessionBooking.engagementId, params.engagementId),
      ),
    );
}

function line(item: SessionListItem): string {
  const when = item.scheduledAt.toISOString().slice(0, 16).replace("T", " ");
  const state = item.resolution ? `${item.status}/${item.resolution}` : item.status;
  return `    ${when}  ${state.padEnd(26)} ${item.action.padEnd(20)} with ${item.otherPartyName}`;
}

function printBoard(label: string, board: SessionBoard): void {
  console.log(`\n  ${label}`);
  for (const [bucket, items] of [
    ["awaiting answer", board.awaitingAnswer],
    ["upcoming", board.upcoming],
    ["past", board.past],
  ] as const) {
    console.log(`  ${bucket} (${items.length})`);
    items.forEach((item) => console.log(line(item)));
  }
}

async function main(): Promise<void> {
  const student = await actorFor(STUDENT);
  const tutor = await tutorActorFor(ACCEPTING_TUTOR);
  const target = await resolveTarget({
    code: COURSE_CODE,
    section: SECTION,
    tutors: [ACCEPTING_TUTOR, ...ALSO_ASKED],
  });
  const secondTarget = await resolveTarget({
    code: SECOND_COURSE_CODE,
    section: SECOND_SECTION,
    tutors: [SECOND_TUTOR],
  });

  const removed = await cleanup(student, [target, secondTarget]);
  console.log(
    `\ncleaned up ${removed.engagements} previous demo engagement(s), ${removed.requests} stray request(s)`,
  );

  const asked = await requestTutors({
    actor: student,
    courseOfferingId: target.courseOfferingId,
    tutorCourseIds: target.tutorCourseIds,
  });
  console.log(`${student.name} asked ${asked.created} tutors (cap ${asked.limit})`);

  const pending = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(
      and(
        eq(matchRequest.studentProfileId, student.studentProfileId),
        eq(matchRequest.tutorCourseId, target.accepterTutorCourseId),
        eq(matchRequest.status, "pending"),
      ),
    )
    .limit(1);

  const requestId = pending.at(0)?.id;
  if (!requestId) throw new Error("no pending request for the accepting tutor");

  await acceptRequest({ tutor, requestId });
  console.log(`${tutor.name} accepted — the other asks auto-withdrew`);

  const slots = await slotsForRequest({ actor: student, requestId });
  if (slots.length < 4) throw new Error(`only ${slots.length} slots available, need 4`);

  const exams = await upcomingExams(target.courseOfferingId);
  const anchor = exams.at(0) ?? null;

  const { engagementId } = await purchasePackage({
    actor: student,
    requestId,
    kind: "exam_anchored",
    anchorExamId: anchor?.id ?? null,
    slotStartsAt: slots[0],
  });
  console.log(
    `package purchased${anchor ? `, anchored to ${anchor.name} on ${anchor.occursOn}` : ""}`,
  );

  const booked: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const open = await slotsForEngagement({ actor: student, engagementId });
    const { sessionId } = await bookSession({
      actor: student,
      engagementId,
      slotStartsAt: open[0],
      locationNote: LOCATION_NOTE,
    });
    booked.push(sessionId);
  }

  const all = await db
    .select({ id: sessionBooking.id })
    .from(sessionBooking)
    .where(eq(sessionBooking.engagementId, engagementId))
    .orderBy(sessionBooking.scheduledAt);

  const [completed, disputed, awaiting] = all.map((row) => row.id);
  console.log(`${all.length} sessions booked`);

  await moveIntoPast({ engagementId, sessionId: completed, hoursAgo: 6 });
  await moveIntoPast({ engagementId, sessionId: disputed, hoursAgo: 4 });
  await moveIntoPast({ engagementId, sessionId: awaiting, hoursAgo: 2 });

  await confirmAttendance({ actor: student, sessionId: completed });
  const settled = await confirmAttendance({ actor: tutor, sessionId: completed });
  console.log(`session 1 → ${settled.status}/${settled.resolution}`);

  await confirmAttendance({ actor: student, sessionId: disputed });
  const contested = await denyAttendance({
    actor: tutor,
    sessionId: disputed,
    note: "Student did not arrive; waited 25 minutes.",
  });
  console.log(`session 2 → ${contested.status}/${contested.resolution}`);

  console.log("session 3 → left unanswered (awaiting an answer from both sides)");
  console.log("session 4 → still upcoming");

  const second = await autoReleasedPackage(student, secondTarget);

  printBoard(`${student.name} (student)`, await sessionBoardForStudent(student));
  printBoard(`${tutor.name} (tutor)`, await sessionBoardForTutor(tutor));

  await printLedger(`${COURSE_CODE} with ${tutor.name}`, engagementId);
  await printLedger(`${SECOND_COURSE_CODE} with ${second.tutorName}`, second.engagementId);
}

async function printLedger(label: string, engagementId: string): Promise<void> {
  const balance = await balanceFor(engagementId);
  console.log(`\n  ledger — ${label}`);
  console.log(`    paid        ${formatMinor(balance.paidMinor)}`);
  console.log(`    recognised  ${formatMinor(balance.recognisedMinor)}`);
  console.log(`    deferred    ${formatMinor(balance.deferredMinor)}`);
  console.log(`    tutor owed  ${formatMinor(balance.tutorOwedMinor)}`);
  console.log(`    refunded    ${formatMinor(balance.refundedMinor)}`);
}

async function autoReleasedPackage(
  student: Actor,
  target: Target,
): Promise<{ engagementId: string; tutorName: string }> {
  const tutor = await tutorActorFor(SECOND_TUTOR);

  await requestTutors({
    actor: student,
    courseOfferingId: target.courseOfferingId,
    tutorCourseIds: target.tutorCourseIds,
  });

  const pending = await db
    .select({ id: matchRequest.id })
    .from(matchRequest)
    .where(
      and(
        eq(matchRequest.studentProfileId, student.studentProfileId),
        eq(matchRequest.tutorCourseId, target.accepterTutorCourseId),
        eq(matchRequest.status, "pending"),
      ),
    )
    .limit(1);

  const requestId = pending.at(0)?.id;
  if (!requestId) throw new Error(`no pending request for ${SECOND_TUTOR}`);

  await acceptRequest({ tutor, requestId });

  const slots = await slotsForRequest({ actor: student, requestId });
  if (slots.length === 0) throw new Error(`${SECOND_TUTOR} has no open slots`);

  const exams = await upcomingExams(target.courseOfferingId);
  const { engagementId } = await purchasePackage({
    actor: student,
    requestId,
    kind: "exam_anchored",
    anchorExamId: exams.at(0)?.id ?? null,
    slotStartsAt: slots[0],
  });

  const [booking] = await db
    .select({ id: sessionBooking.id })
    .from(sessionBooking)
    .where(eq(sessionBooking.engagementId, engagementId));

  await moveIntoPast({ engagementId, sessionId: booking.id, hoursAgo: 26 });

  const released = await releaseLapsedConfirmations();
  console.log(`${tutor.name}: ${released} lapsed session(s) auto-released — paid on silence`);

  return { engagementId, tutorName: tutor.name };
}

main()
  .then(() => db.$client.end())
  .catch(async (error) => {
    console.error(error);
    await db.$client.end();
    process.exitCode = 1;
  });
