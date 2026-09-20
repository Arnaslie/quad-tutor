/**
 * Local demo activity, driven through the real module functions.
 *
 * `db:seed` creates the world and never the money — see the header there. This
 * script is the sanctioned other half: it produces engagements, sessions,
 * ledger entries and reliability facts by *calling the functions that will run
 * in production* — `requestTutors` → `acceptRequest` → `purchasePackage` →
 * `bookSession` → `confirmAttendance` / `denyAttendance` — rather than by
 * inserting rows. Nothing here is invented. The ledger is consistent because
 * the real code wrote it, and if any of those functions is wrong, this script
 * is wrong in exactly the same way, which is the point.
 *
 * It exists because two states cannot be reached from a browser: `viewerAction`
 * only offers `confirm_or_deny` once a session's end time has passed, and
 * `availableSlots` enforces a 12-hour minimum lead. So confirm/deny — the most
 * adversarial screen in the product — is unreachable by clicking, on any day.
 *
 * THE CLOCK SEAM is the one hand-written part, and it is deliberately narrow:
 * this script may move `scheduled_at` and `confirmation_window_ends_at`, and
 * only on bookings it created in this run. It must never write `status`,
 * `resolution`, a ledger row or a reliability fact directly. Every one of those
 * has to come from a real function reacting to the moved clock — the moment
 * this script sets an outcome itself, it is fixturing money again and the
 * ledger stops meaning anything.
 *
 * Re-runnable: it deletes what a previous run created before recreating, keyed
 * on a marker it writes into `location_note`. It never touches seeded rows or
 * rows it did not create.
 *
 * IF THE BOARD LOOKS WRONG, RE-RUN IT. The board a run leaves drifts twice, and
 * neither drift is a bug — both are the product working on a database that sat.
 *
 *   ~23h after a run: the awaiting-answer session's confirmation window lapses.
 *     `confirmationDeadline` gives it 25 hours from its start and the backdate
 *     below puts it 2 hours past its start, so it is 23 hours from the run, not
 *     25 — do not plan on having a full day. The next board read sweeps it
 *     through `releaseLapsedConfirmations`, it auto-releases to `attended` and
 *     the tutor is paid, so the bucket this script exists to show is traded for
 *     a `past` / `auto_released` one.
 *
 *   ~6.7 days after a run: the upcoming session's own start time passes and it
 *     moves from `upcoming` to `awaitingAnswer` by itself.
 *
 * The two settled sessions cannot drift at all: the sweep only selects rows
 * still `scheduled`, so `completed` and `disputed` stay put however long the
 * database sits. A fresh run puts the whole board back.
 *
 * Run with `npm run db:demo`.
 */

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

/* -------------------------------------------------------------------------- */
/* cast                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Written into every session this script books, and the handle cleanup uses to
 * recognise its own work. A human clicking through the UI would have to type
 * this string exactly to be mistaken for it.
 */
const MARKER = "db:demo";
const LOCATION_NOTE = `Gorgas Library, 2nd floor [${MARKER}]`;

/**
 * Deliberately not `maya.chen` on either side: she has a live engagement a
 * teammate is working against, and nothing here may go near it. She is also
 * the seed's dual-role user, and a package with the same person on both sides
 * is refused by `purchasePackage` anyway.
 */
const STUDENT = "owen.drake@crimson.ua.edu";
const ACCEPTING_TUTOR = "jordan.ellis@crimson.ua.edu";
/** Asked in the same batch and auto-withdrawn when the first tutor accepts. */
const ALSO_ASKED = ["sofia.marek@crimson.ua.edu", "caleb.nguyen@crimson.ua.edu"];

const COURSE_CODE = "CH 101";
const SECTION = "001";

/**
 * A second package, with a different tutor, for the auto-release path.
 *
 * It needs its own engagement because a four-session exam-anchored package —
 * the default product, and the one worth showing — has room for four sessions,
 * and the first four states already use them. A student carrying two courses
 * is the ordinary shape here anyway: `engagement` is many-to-many for exactly
 * this reason.
 */
const SECOND_COURSE_CODE = "ST 260";
const SECOND_SECTION = "001";
const SECOND_TUTOR = "priyanka.shah@crimson.ua.edu";

/* -------------------------------------------------------------------------- */
/* actors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one thing this script fakes, and it fakes nothing about the domain.
 *
 * Every module function takes an `Actor`, not a session — that separation is
 * what makes them callable here at all. `currentActor` builds one from a
 * verified Better Auth session; this builds the same shape from the same
 * tables, because there is no HTTP request to carry a cookie. Authorisation is
 * unchanged: the functions still check campus, ownership and role from the
 * actor they are handed.
 */
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

/* -------------------------------------------------------------------------- */
/* the course everyone is talking about                                       */
/* -------------------------------------------------------------------------- */

type Target = {
  courseOfferingId: string;
  /** `tutorCourse` ids, in ask order: the accepting tutor first. */
  tutorCourseIds: string[];
  accepterTutorCourseId: string;
};

async function resolveTarget(cast: {
  code: string;
  section: string;
  /** The accepting tutor first; the rest are asked in the same batch. */
  tutors: string[];
}): Promise<Target> {
  // The code is resolved through `courseCodeAlias`, never stored on the course
  // — "CH 101" is the string that moves when a course is renumbered.
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

/* -------------------------------------------------------------------------- */
/* cleanup                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Remove what a previous run created, and nothing else.
 *
 * Two handles, both narrow. The first is the marker this script writes into
 * `location_note`, so an engagement created by a person clicking through the
 * app is invisible here. The second catches an engagement whose only session
 * came from `purchasePackage` and therefore carries no note: it is found
 * through its match request, and only when that request is one of this
 * script's own (student, offering, tutor) triples.
 *
 * The same triples, minus anything an engagement is built on, are what a run
 * that died halfway leaves behind.
 */
async function cleanup(
  actor: Actor,
  targets: Target[],
): Promise<{ engagements: number; requests: number }> {
  const offeringIds = targets.map((target) => target.courseOfferingId);
  const tutorCourseIds = targets.flatMap((target) => target.tutorCourseIds);

  /** Every request this script would ever have made, whatever became of it. */
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

    // Requests from a run that died before it bought anything. The attached
    // ids are collected in JS rather than as a subquery, because `notInArray`
    // against a set containing a null matches nothing at all in SQL.
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

/* -------------------------------------------------------------------------- */
/* the clock seam                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Move one booking into the past. THE ONLY hand-written state in this script.
 *
 * Two columns, on one booking, inside one engagement this run just created —
 * the `engagementId` predicate is there so a bug in the caller cannot reach a
 * session belonging to anyone else. The confirmation window is recomputed with
 * the real `confirmationDeadline`, not a hand-picked number, so a session that
 * has finished still has an open window to answer in, exactly as it would on
 * the day.
 *
 * What this must never set: `status`, `resolution`, a ledger entry, a
 * reliability event. Those are the outcomes, and they come from the module
 * functions below reacting to this clock.
 */
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

/* -------------------------------------------------------------------------- */
/* the run                                                                    */
/* -------------------------------------------------------------------------- */

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

  // 1. The student asks three tutors at once. Parallel, non-exclusive: the
  //    wait becomes "who says yes first", not "will anyone say yes".
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

  // 2. First acceptance wins; the other two withdraw in the same transaction.
  await acceptRequest({ tutor, requestId });
  console.log(`${tutor.name} accepted — the other asks auto-withdrew`);

  // 3. Money moves only now, and only through the real purchase path.
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

  // 4. The rest of the package, booked the way a student books it.
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

  // 5. Three of them are moved into the past — the only hand-written state —
  //    and then answered through the real functions.
  await moveIntoPast({ engagementId, sessionId: completed, hoursAgo: 6 });
  await moveIntoPast({ engagementId, sessionId: disputed, hoursAgo: 4 });
  await moveIntoPast({ engagementId, sessionId: awaiting, hoursAgo: 2 });

  // Both say it happened: delivered, and the only point where deferred
  // revenue becomes recognised.
  await confirmAttendance({ actor: student, sessionId: completed });
  const settled = await confirmAttendance({ actor: tutor, sessionId: completed });
  console.log(`session 1 → ${settled.status}/${settled.resolution}`);

  // Contested: a confirmation against a denial never settles itself.
  await confirmAttendance({ actor: student, sessionId: disputed });
  const contested = await denyAttendance({
    actor: tutor,
    sessionId: disputed,
    note: "Student did not arrive; waited 25 minutes.",
  });
  console.log(`session 2 → ${contested.status}/${contested.resolution}`);

  // Session 3 is left unanswered on purpose, and session 4 is still upcoming.
  console.log("session 3 → left unanswered (awaiting an answer from both sides)");
  console.log("session 4 → still upcoming");

  // 6. A second package, so the auto-release path is on the board rather than
  //    only in a test: a tutor paid on a student's silence. Nobody answers
  //    this one — it is backdated past its confirmation window and the sweep
  //    settles it, which is the whole point.
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

/**
 * The fifth state: delivered because nobody said otherwise.
 *
 * A lapsed confirmation window defaults to attended — leaving a tutor unpaid
 * on a student's silence would destroy the scarce side of the marketplace —
 * and it writes no reliability fact, because silence is not a fact about
 * anyone. It is the sharpest decision in the design and the only path where
 * money moves without either party acting, so it belongs on a board somebody
 * looks at, not only in a test somebody has to go and read.
 *
 * Note nothing here answers the session. The backdate puts it past its window
 * and `releaseLapsedConfirmations` does the rest — the same sweep that runs on
 * every board read in production.
 */
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

  // 26 hours back puts it an hour beyond its own 25-hour window, so the sweep
  // picks it up. Still far inside the board's 200-day history.
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
