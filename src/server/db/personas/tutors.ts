import { and, asc, desc, eq, isNull, lt, sql } from "drizzle-orm";

import { db } from "../index";
import { courseCodeAlias, courseOffering, term, tutorCourse } from "../schema";
import { openPackage, renewPackage, type Target } from "../scenarios/packages";
import { backdateLedger, moveIntoPast, sessionIdsInOrder } from "../scenarios/sessions";

import type { KycStatus } from "@/server/modules/billing/kyc";
import { formatMinor, type RequestedKind } from "@/server/modules/billing/pricing";
import { currentTerm } from "@/server/modules/catalog/courses";
import { confirmAttendance, denyAttendance } from "@/server/modules/engagements/confirmation";
import { fixturePay, fixturePayout } from "@/server/modules/engagements/fixture-pay";
import { bookSession, slotsForEngagement } from "@/server/modules/engagements/scheduling";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import { rateSession } from "@/server/modules/ratings/capture";
import type { Stars } from "@/server/modules/ratings/rules";
import { addAvailabilityWindow } from "@/server/modules/tutoring/availability";
import { claimCourse, setCourseRate } from "@/server/modules/tutoring/courses";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";
import { setDefaultLocation } from "@/server/modules/tutoring/location";
import { rateMinorFromDollars } from "@/server/modules/tutoring/rate-rules";

import { createPersona, createTutorPersona, personaEmail, type PersonaCampus, type PersonaSummary } from "./people";

type Pack = {
  kind?: RequestedKind;
  delivered: number;
  stars?: readonly Stars[];
  renews?: true;
  disputed?: true;
  paidOut?: true;
};

type TutorPersona = {
  key: string;
  name: string;
  headline: string;
  course: string;
  rateDollars: number;
  kyc: KycStatus;
  packs: readonly Pack[];
};

const four = (pack: Omit<Pack, "delivered"> = {}): Pack => ({ delivered: 4, ...pack });

const renewing = (pairs: number, pack: Omit<Pack, "delivered" | "renews"> = {}): Pack[] =>
  Array.from({ length: pairs }, () => [four(pack), four({ ...pack, renews: true })]).flat();

export const TUTOR_PERSONAS: readonly TutorPersona[] = [
  {
    key: "tutor-new",
    name: "Rosa Delgado",
    headline: "Just approved for CS 100",
    course: "CS 100",
    rateDollars: 30,
    kyc: "not_started",
    packs: [],
  },
  {
    key: "tutor-1",
    name: "Theo Grant",
    headline: "One session in, Calc I",
    course: "MATH 125",
    rateDollars: 50,
    kyc: "verified",
    packs: [{ delivered: 1 }],
  },
  {
    key: "tutor-9",
    name: "Lena Okafor",
    headline: "Gen Chem, nine sessions so far",
    course: "CH 101",
    rateDollars: 100,
    kyc: "verified",
    packs: [four({ stars: [5, 4, 5, 5] }), four({ stars: [4, 5] }), { delivered: 1 }],
  },
  {
    key: "tutor-10",
    name: "Marcus Bell",
    headline: "Calc II, rating just went public",
    course: "MATH 126",
    rateDollars: 100,
    kyc: "verified",
    packs: [four({ stars: [5, 5, 4, 5] }), four({ stars: [5] }), { delivered: 2 }],
  },
  {
    key: "tutor-ranked",
    name: "Priya Anand",
    headline: "Bio I regular, most students book again",
    course: "BSC 114",
    rateDollars: 45,
    kyc: "verified",
    packs: [
      ...renewing(3, { stars: [5, 5, 4, 5] }),
      four({ stars: [4, 5, 5, 4] }),
      four({ stars: [5, 4, 4, 5] }),
    ],
  },
  {
    key: "tutor-32",
    name: "Jonah Weiss",
    headline: "Intro micro, 32 sessions this term",
    course: "EC 110",
    rateDollars: 35,
    kyc: "verified",
    packs: renewing(4).map((pack, i) => (i < 5 ? { ...pack, paidOut: true as const } : pack)),
  },
  {
    key: "tutor-past-100",
    name: "Hana Sato",
    headline: "Stats, past $100 in fees and on 5% for good",
    course: "ST 260",
    rateDollars: 50,
    kyc: "verified",
    packs: renewing(4).map((pack, i) => (i < 7 ? { ...pack, paidOut: true as const } : pack)),
  },
  {
    key: "tutor-held",
    name: "Eli Brennan",
    headline: "Physics, payouts not set up yet",
    course: "PH 105",
    rateDollars: 25,
    kyc: "not_started",
    packs: [
      { kind: "through_final", delivered: 8 },
      { kind: "through_final", delivered: 3, renews: true },
    ],
  },
  {
    key: "tutor-disputed",
    name: "Nadia Ruiz",
    headline: "Accounting, one session in dispute",
    course: "AC 210",
    rateDollars: 40,
    kyc: "verified",
    packs: [{ delivered: 2, disputed: true }],
  },
];

const STUDENT_NAMES = ["Avery Brooks", "Caleb Moore", "Dana Fischer", "Evan Cho", "Fiona Hale", "Gabe Ortiz", "Ivy Lambert", "Jules Park"];

const LOCATION = "Gorgas Library, 2nd floor study rooms";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RATINGS_CLOSED = 8 * DAY;

async function offeringFor(institutionId: string, code: string) {
  const [row] = await db
    .select({ id: courseOffering.id, courseId: courseOffering.courseId, professorId: courseOffering.professorId })
    .from(courseOffering)
    .innerJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, courseOffering.courseId), isNull(courseCodeAlias.validToTermId)),
    )
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(courseOffering.institutionId, institutionId),
        eq(courseCodeAlias.code, code),
        sql`current_date between ${term.startsOn} and ${term.endsOn}`,
      ),
    )
    .orderBy(asc(courseOffering.section))
    .limit(1);
  if (!row) throw new Error(`No ${code} offering this term — run db:catalog first.`);
  return row;
}

export async function lastEndedTerm(institutionId: string): Promise<{ id: string; endsOn: string }> {
  const [row] = await db
    .select({ id: term.id, endsOn: term.endsOn })
    .from(term)
    .where(and(eq(term.institutionId, institutionId), lt(term.endsOn, sql`current_date`)))
    .orderBy(desc(term.endsOn))
    .limit(1);
  if (!row) throw new Error("No past term to have taken the course in — run db:catalog first.");
  return row;
}

export async function claimedTutor(
  campus: PersonaCampus,
  persona: Omit<TutorPersona, "packs">,
): Promise<{ tutor: TutorActor; target: Target; rateMinor: number }> {
  const rateMinor = rateMinorFromDollars(persona.rateDollars);
  if (rateMinor === null) throw new Error(`${persona.key}: $${persona.rateDollars} is not a rate a tutor can set.`);
  const tutor = await createTutorPersona(campus, persona);
  const offering = await offeringFor(campus.institutionId, persona.course);
  const { tutorCourseId } = await claimCourse({
    tutor,
    courseId: offering.courseId,
    takenTermId: (await lastEndedTerm(campus.institutionId)).id,
    takenUnderProfessorId: offering.professorId,
    gradeEarned: "A",
  });
  await setCourseRate({ tutor, tutorCourseId, rateMinor });
  await db
    .update(tutorCourse)
    .set({ status: "active", verifiedAt: sql`now()`, reviewedAt: sql`now()` })
    .where(and(eq(tutorCourse.id, tutorCourseId), eq(tutorCourse.institutionId, campus.institutionId)));

  for (let weekday = 0; weekday < 7; weekday += 1) {
    await addAvailabilityWindow({ tutor, weekday, startMinute: 8 * 60, endMinute: 20 * 60 });
  }
  await setDefaultLocation({ tutor, location: LOCATION });

  return {
    tutor,
    target: { courseOfferingId: offering.id, tutorCourseIds: [tutorCourseId], accepterTutorCourseId: tutorCourseId },
    rateMinor,
  };
}

export async function historyTimes(institutionId: string, count: number): Promise<Date[]> {
  if (count === 0) return [];
  const current = await currentTerm(institutionId);
  if (!current) throw new Error("No term is running today, so there is no term to give the personas a history in.");
  const from = new Date(`${current.startsOn}T00:00:00Z`).getTime() + DAY;
  const span = Date.now() - RATINGS_CLOSED - from;
  if (span < count * HOUR) {
    throw new Error(`${current.name} started too recently to hold ${count} sessions whose rating windows have closed.`);
  }
  const step = span / Math.max(1, count);
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(from + i * step);
    at.setUTCMinutes(0, 0, 0);
    return at;
  });
}

export async function teach(params: {
  student: Actor;
  tutor: TutorActor;
  engagementId: string;
  sessionId: string;
  stars: Stars | undefined;
  taughtAt: Date;
}): Promise<void> {
  const { student, tutor, engagementId, sessionId } = params;
  await moveIntoPast({ engagementId, sessionId, hoursAgo: 3 });
  await confirmAttendance({ actor: student, sessionId });
  await confirmAttendance({ actor: tutor, sessionId });
  if (params.stars) await rateSession({ actor: student, sessionId, stars: params.stars, note: null });

  const hoursAgo = (Date.now() - params.taughtAt.getTime()) / HOUR;
  await moveIntoPast({ engagementId, sessionId, hoursAgo });
  await backdateLedger({ engagementId, sessionId, at: new Date(params.taughtAt.getTime() + HOUR) });
}

export async function nextSession(actor: Actor, engagementId: string): Promise<string> {
  const [slotStartsAt] = await slotsForEngagement({ actor, engagementId });
  const { sessionId } = await bookSession({ actor, engagementId, slotStartsAt });
  return sessionId;
}

async function buildTutor(campus: PersonaCampus, persona: TutorPersona): Promise<PersonaSummary> {
  const { tutor, target, rateMinor } = await claimedTutor(campus, persona);
  const times = await historyTimes(
    campus.institutionId,
    persona.packs.reduce((sum, pack) => sum + pack.delivered, 0),
  );

  let student: Actor | null = null;
  let students = 0;
  for (const pack of persona.packs) {
    const purchase = { tutor, target, slotsNeeded: 1, kind: pack.kind, settle: fixturePay };
    if (!pack.renews || !student) {
      student = await createPersona(campus, `${persona.key}-student-${students + 1}`, STUDENT_NAMES[students % STUDENT_NAMES.length]);
      students += 1;
    }
    const { engagementId } = pack.renews
      ? await renewPackage({ ...purchase, student })
      : await openPackage({ ...purchase, student });

    for (let i = 0; i < pack.delivered; i += 1) {
      const sessionId = i === 0 ? (await sessionIdsInOrder(engagementId))[0] : await nextSession(student, engagementId);
      await teach({ student, tutor, engagementId, sessionId, stars: pack.stars?.[i], taughtAt: times.shift()! });
    }

    if (pack.disputed) {
      const sessionId = await nextSession(student, engagementId);
      await moveIntoPast({ engagementId, sessionId, hoursAgo: 5 });
      await confirmAttendance({ actor: tutor, sessionId });
      await denyAttendance({ actor: student, sessionId, note: "My tutor never showed up." });
    }

    if (pack.paidOut) await fixturePayout({ engagementId, institutionId: campus.institutionId });
  }

  const earnings = await earningsForTutor(tutor);
  return {
    key: persona.key,
    email: personaEmail(campus, persona.key),
    role: "tutor",
    state: [
      `${persona.course} at ${formatMinor(rateMinor)}`,
      `${earnings.sessionsDelivered} session${earnings.sessionsDelivered === 1 ? "" : "s"}`,
      `${formatMinor(earnings.earnedMinor)} earned`,
      `${formatMinor(earnings.owedMinor)} owed`,
      persona.kyc === "verified" ? null : "payouts not set up",
    ]
      .filter(Boolean)
      .join(", "),
  };
}

export function buildTutorPersonas(campus: PersonaCampus): Promise<PersonaSummary[]> {
  return Promise.all(TUTOR_PERSONAS.map((persona) => buildTutor(campus, persona)));
}
