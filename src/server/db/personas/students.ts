import { acceptedRequest, openPackage } from "../scenarios/packages";
import { moveIntoPast, sessionIdsInOrder } from "../scenarios/sessions";

import { formatMinor, packageSummary, type RequestedKind } from "@/server/modules/billing/pricing";
import { confirmAttendance } from "@/server/modules/engagements/confirmation";
import { fixturePay } from "@/server/modules/engagements/fixture-pay";
import { bookAgainList, packagesForStudent, sessionBoardForStudent } from "@/server/modules/engagements/reads";
import { cancelSession } from "@/server/modules/engagements/scheduling";
import type { Actor } from "@/server/modules/identity/actor";
import { requestsForStudent, standingFor } from "@/server/modules/matching/requests";
import { MAX_PARALLEL_ASKS } from "@/server/modules/reliability/standing";

import { createPersona, personaEmail, type PersonaCampus, type PersonaSummary } from "./people";
import { claimedTutor, historyTimes, nextSession, teach } from "./tutors";

type Next = "upcoming" | "ended" | "late_cancel";

type Pair = {
  tutorName: string;
  course: string;
  rateDollars: number;
  kind: RequestedKind;
  bought?: { delivered: number; steps?: readonly Next[] };
};

type StudentPersona = { key: string; name: string; pair?: Pair };

export const STUDENT_PERSONAS: readonly StudentPersona[] = [
  { key: "student-new", name: "Maya Collins" },
  {
    key: "student-accepted",
    name: "Noah Reed",
    pair: { tutorName: "Owen Price", course: "MATH 125", rateDollars: 40, kind: "exam_anchored" },
  },
  {
    key: "student-mid",
    name: "Sofia Patel",
    pair: {
      tutorName: "Grace Kim",
      course: "CH 101",
      rateDollars: 30,
      kind: "exam_anchored",
      bought: { delivered: 2, steps: ["upcoming"] },
    },
  },
  {
    key: "student-confirm",
    name: "Liam Foster",
    pair: {
      tutorName: "Ben Carter",
      course: "BSC 114",
      rateDollars: 45,
      kind: "exam_anchored",
      bought: { delivered: 1, steps: ["ended"] },
    },
  },
  {
    key: "student-done",
    name: "Emma Walsh",
    pair: { tutorName: "Zoe Hart", course: "MATH 126", rateDollars: 35, kind: "exam_anchored", bought: { delivered: 4 } },
  },
  {
    key: "student-refund",
    name: "Lucas Gray",
    pair: { tutorName: "Ruby Lane", course: "EC 110", rateDollars: 25, kind: "through_final" },
  },
  {
    key: "student-strikes",
    name: "Chloe Diaz",
    pair: {
      tutorName: "Sam Novak",
      course: "ST 260",
      rateDollars: 50,
      kind: "exam_anchored",
      bought: { delivered: 1, steps: ["late_cancel", "late_cancel"] },
    },
  },
];

export async function describe(student: Actor): Promise<string> {
  const [packages, requests, again, board, standing] = await Promise.all([
    packagesForStudent(student),
    requestsForStudent(student),
    bookAgainList(student),
    sessionBoardForStudent(student),
    standingFor(student),
  ]);
  const parts = [
    ...requests
      .filter((request) => request.status === "accepted" && !request.engagementId)
      .map(
        (request) =>
          `${request.courseCode} request accepted by ${request.tutorName}, ready to buy ` +
          `${packageSummary(request.requestedKind ?? "exam_anchored")} at ${formatMinor(request.rateMinor)} a session`,
      ),
    ...packages.map(
      (pkg) =>
        `${pkg.courseCode} with ${pkg.tutorName}, ${pkg.sessionsDelivered} of ${pkg.sessionsPurchased} done, ` +
        `${pkg.sessionsRemaining} left to book, paid ${formatMinor(pkg.pricePaidMinor)}` +
        (pkg.anchorExamName ? `, ${pkg.anchorExamName} on ${pkg.anchorExamOccursOn}` : ""),
    ),
    ...again.map((pair) => `Book again open with ${pair.tutorName} in ${pair.courseCode}`),
    board.upcoming.length > 0 ? `${board.upcoming.length} coming up` : null,
    board.awaitingAnswer.length > 0 ? `${board.awaitingAnswer.length} to confirm` : null,
    standing.parallelAskLimit < MAX_PARALLEL_ASKS ? `can ask ${standing.parallelAskLimit} tutor at a time` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "signed up, nothing requested";
}

async function buildStudent(campus: PersonaCampus, persona: StudentPersona): Promise<PersonaSummary[]> {
  const student = await createPersona(campus, persona.key, persona.name);
  const summary = async (): Promise<PersonaSummary> => ({
    key: persona.key,
    email: personaEmail(campus, persona.key),
    role: "student",
    state: await describe(student),
  });
  const { pair } = persona;
  if (!pair) return [await summary()];

  const tutorKey = `${persona.key}-tutor`;
  const { tutor, target, rateMinor } = await claimedTutor(campus, {
    key: tutorKey,
    name: pair.tutorName,
    headline: `${pair.course} tutor`,
    course: pair.course,
    rateDollars: pair.rateDollars,
    kyc: "not_started",
  });

  if (!pair.bought) {
    await acceptedRequest({ student, tutor, target, kind: pair.kind });
  } else {
    const { delivered, steps = [] } = pair.bought;
    const times = await historyTimes(campus.institutionId, delivered);
    const { engagementId } = await openPackage({ student, tutor, target, slotsNeeded: 1, kind: pair.kind, settle: fixturePay });
    for (let i = 0; i < delivered; i += 1) {
      const sessionId = i === 0 ? (await sessionIdsInOrder(engagementId))[0] : await nextSession(student, engagementId);
      await teach({ student, tutor, engagementId, sessionId, stars: undefined, taughtAt: times.shift()! });
    }
    for (const next of steps) {
      const sessionId = await nextSession(student, engagementId);
      if (next === "upcoming") await moveIntoPast({ engagementId, sessionId, hoursAgo: -48 });
      if (next === "ended") {
        await moveIntoPast({ engagementId, sessionId, hoursAgo: 2 });
        await confirmAttendance({ actor: tutor, sessionId });
      }
      if (next === "late_cancel") {
        await moveIntoPast({ engagementId, sessionId, hoursAgo: -2 });
        await cancelSession({ actor: student, sessionId });
      }
    }
  }

  return [
    await summary(),
    {
      key: tutorKey,
      email: personaEmail(campus, tutorKey),
      role: "tutor",
      state: `${pair.course} at ${formatMinor(rateMinor)}, tutors ${persona.key}, payouts not set up`,
    },
  ];
}

export async function buildStudentPersonas(campus: PersonaCampus): Promise<PersonaSummary[]> {
  const built: PersonaSummary[] = [];
  for (const persona of STUDENT_PERSONAS) built.push(...(await buildStudent(campus, persona)));
  return built;
}
