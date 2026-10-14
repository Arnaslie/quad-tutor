import { db } from "./index";
import { cleanupByMarker } from "./scenarios/cleanup";
import { openPackage, resolveTarget } from "./scenarios/packages";
import { actorFor, tutorActorFor, userIdByEmail } from "./scenarios/people";
import { bookSessions, moveIntoPast, sessionIdsInOrder } from "./scenarios/sessions";

import { balanceFor } from "@/server/modules/billing/ledger";
import { formatMinor } from "@/server/modules/billing/pricing";
import {
  confirmAttendance,
  denyAttendance,
  releaseLapsedConfirmations,
} from "@/server/modules/engagements/confirmation";
import {
  sessionBoardForStudent,
  sessionBoardForTutor,
  type SessionBoard,
  type SessionListItem,
} from "@/server/modules/engagements/reads";

const MARKER = "db:demo";
const STUDENT_NOTE = `Bringing last year's midterm [${MARKER}]`;

const STUDENT = "seed_owen-drake";
const ACCEPTING_TUTOR = "seed_jordan-ellis";

const ALSO_ASKED = ["seed_sofia-marek", "seed_caleb-nguyen"];

const COURSE_CODE = "CH 101";
const SECTION = "001";

const SECOND_COURSE_CODE = "ST 260";
const SECOND_SECTION = "001";
const SECOND_TUTOR = "seed_priyanka-shah";

async function studentUserId(): Promise<string> {
  const email = process.argv.at(2)?.trim().toLowerCase();
  return email ? userIdByEmail(email) : STUDENT;
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

async function printLedger(label: string, engagementId: string): Promise<void> {
  const balance = await balanceFor(engagementId);
  console.log(`\n  ledger — ${label}`);
  console.log(`    paid        ${formatMinor(balance.paidMinor)}`);
  console.log(`    recognised  ${formatMinor(balance.recognisedMinor)}`);
  console.log(`    deferred    ${formatMinor(balance.deferredMinor)}`);
  console.log(`    tutor owed  ${formatMinor(balance.tutorOwedMinor)}`);
  console.log(`    refunded    ${formatMinor(balance.refundedMinor)}`);
}

async function main(): Promise<void> {
  const student = await actorFor(await studentUserId());
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

  const removed = await cleanupByMarker({
    student,
    targets: [target, secondTarget],
    marker: MARKER,
  });
  console.log(
    `\ncleaned up ${removed.engagements} previous demo engagement(s), ${removed.requests} stray request(s)`,
  );

  const { engagementId, asked, anchor } = await openPackage({
    student,
    tutor,
    target,
    slotsNeeded: 4,
  });
  console.log(`${student.name} asked ${asked.created} tutors (cap ${asked.limit})`);
  console.log(`${tutor.name} accepted — the other asks auto-withdrew`);
  console.log(
    `package purchased${anchor ? `, anchored to ${anchor.name} on ${anchor.occursOn}` : ""}`,
  );

  await bookSessions({ student, engagementId, count: 3, studentNote: STUDENT_NOTE });

  const all = await sessionIdsInOrder(engagementId);
  const [completed, disputed, awaiting] = all;
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

  const secondTutor = await tutorActorFor(SECOND_TUTOR);
  const second = await openPackage({
    student,
    tutor: secondTutor,
    target: secondTarget,
    slotsNeeded: 1,
  });
  const [lapsed] = await sessionIdsInOrder(second.engagementId);
  await moveIntoPast({ engagementId: second.engagementId, sessionId: lapsed, hoursAgo: 26 });

  const released = await releaseLapsedConfirmations();
  console.log(`${secondTutor.name}: ${released} lapsed session(s) auto-released — paid on silence`);

  printBoard(`${student.name} (student)`, await sessionBoardForStudent(student));
  printBoard(`${tutor.name} (tutor)`, await sessionBoardForTutor(tutor));

  await printLedger(`${COURSE_CODE} with ${tutor.name}`, engagementId);
  await printLedger(`${SECOND_COURSE_CODE} with ${secondTutor.name}`, second.engagementId);
}

main()
  .then(() => db.$client.end())
  .catch(async (error) => {
    console.error(error);
    await db.$client.end();
    process.exitCode = 1;
  });
