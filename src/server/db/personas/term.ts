import { eq, sql } from "drizzle-orm";

import { db } from "../index";
import { courseOffering, engagement, exam, matchRequest } from "../schema";
import { openPackage, type Target } from "../scenarios/packages";
import { sessionIdsInOrder } from "../scenarios/sessions";

import { formatMinor } from "@/server/modules/billing/pricing";
import { currentTerm } from "@/server/modules/catalog/courses";
import { fixturePay } from "@/server/modules/engagements/fixture-pay";
import { sessionBoardForTutor } from "@/server/modules/engagements/reads";
import { bookSession, slotsForEngagement } from "@/server/modules/engagements/scheduling";
import { engagementsDueForTermEndRefund } from "@/server/modules/engagements/termEnd";
import type { Actor } from "@/server/modules/identity/actor";
import { earningsForTutor } from "@/server/modules/tutoring/earnings";

import { createPersona, personaEmail, PERSONA_SECTION, type PersonaCampus, type PersonaSummary } from "./people";
import { describe } from "./students";
import { claimedTutor, historyTimes, lastEndedTerm, nextSession, teach } from "./tutors";

const DAY = 24 * 60 * 60 * 1000;
const FINAL_IN_DAYS = 4;
const BOOKED_BEFORE_FINAL = 3;

export const FINALS_COURSE = "MATH 125";
export const TERM_OVER_COURSE = "PH 105";

const FINALS_STUDENTS = [
  { key: "student-finals", name: "Hazel Quinn" },
  { key: "tutor-finals-student-2", name: "Omar Shah" },
  { key: "tutor-finals-student-3", name: "Tess Morgan" },
];

async function personaOffering(target: Target, termId: string): Promise<string> {
  const [real] = await db
    .select({ institutionId: courseOffering.institutionId, courseId: courseOffering.courseId, professorId: courseOffering.professorId })
    .from(courseOffering)
    .where(eq(courseOffering.id, target.courseOfferingId));
  const [row] = await db
    .insert(courseOffering)
    .values({ ...real, termId, section: PERSONA_SECTION })
    .returning({ id: courseOffering.id });
  return row.id;
}

async function bookOnePerDay(student: Actor, engagementId: string, count: number): Promise<void> {
  let earliest = 0;
  for (let i = 0; i < count; i += 1) {
    const slots = await slotsForEngagement({ actor: student, engagementId });
    const slotStartsAt = slots.find((slot) => slot.getTime() >= earliest)!;
    await bookSession({ actor: student, engagementId, slotStartsAt });
    earliest = slotStartsAt.getTime() + DAY;
  }
}

async function buildFinals(campus: PersonaCampus): Promise<PersonaSummary[]> {
  const { tutor, target, rateMinor } = await claimedTutor(campus, {
    key: "tutor-finals",
    name: "Iris Vance",
    headline: "Calc I, finals week",
    course: FINALS_COURSE,
    rateDollars: 45,
    kyc: "verified",
  });
  const times = await historyTimes(campus.institutionId, FINALS_STUDENTS.length);
  const offeringId = await personaOffering(target, (await currentTerm(campus.institutionId))!.id);
  const [final] = await db
    .insert(exam)
    .values({
      institutionId: campus.institutionId,
      courseOfferingId: offeringId,
      name: "Final Exam",
      occursOn: sql`current_date + ${FINAL_IN_DAYS}::int`,
    })
    .returning({ occursOn: exam.occursOn });

  const students: Actor[] = [];
  for (const persona of FINALS_STUDENTS) {
    const student = await createPersona(campus, persona.key, persona.name);
    students.push(student);
    const { engagementId } = await openPackage({
      student,
      tutor,
      target: { ...target, courseOfferingId: offeringId },
      slotsNeeded: 1,
      settle: fixturePay,
    });
    const [sessionId] = await sessionIdsInOrder(engagementId);
    await teach({ student, tutor, engagementId, sessionId, stars: undefined, taughtAt: times.shift()! });
    await bookOnePerDay(student, engagementId, BOOKED_BEFORE_FINAL);
  }

  const [earnings, board] = await Promise.all([earningsForTutor(tutor), sessionBoardForTutor(tutor)]);
  return [
    {
      key: "tutor-finals",
      email: personaEmail(campus, "tutor-finals"),
      role: "tutor",
      state:
        `${FINALS_COURSE} at ${formatMinor(rateMinor)}, ${earnings.sessionsDelivered} sessions, ` +
        `${formatMinor(earnings.earnedMinor)} earned, ${board.upcoming.length} coming up before the final on ${final.occursOn}`,
    },
    {
      key: "student-finals",
      email: personaEmail(campus, "student-finals"),
      role: "student",
      state: await describe(students[0]),
    },
  ];
}

async function buildTermOver(campus: PersonaCampus): Promise<PersonaSummary[]> {
  const tutorKey = "student-term-over-tutor";
  const { tutor, target, rateMinor } = await claimedTutor(campus, {
    key: tutorKey,
    name: "Wes Hollis",
    headline: `${TERM_OVER_COURSE} tutor`,
    course: TERM_OVER_COURSE,
    rateDollars: 40,
    kyc: "not_started",
  });
  const student = await createPersona(campus, "student-term-over", "Mia Torres");
  const ended = await lastEndedTerm(campus.institutionId);
  const lastDay = new Date(`${ended.endsOn}T15:00:00Z`).getTime();

  const { engagementId } = await openPackage({ student, tutor, target, slotsNeeded: 1, settle: fixturePay });
  for (const [i, daysBefore] of [14, 7].entries()) {
    const sessionId = i === 0 ? (await sessionIdsInOrder(engagementId))[0] : await nextSession(student, engagementId);
    await teach({ student, tutor, engagementId, sessionId, stars: undefined, taughtAt: new Date(lastDay - daysBefore * DAY) });
  }

  const offeringId = await personaOffering(target, ended.id);
  await db.update(engagement).set({ courseOfferingId: offeringId, anchorExamId: null }).where(eq(engagement.id, engagementId));
  await db.update(matchRequest).set({ courseOfferingId: offeringId }).where(eq(matchRequest.studentProfileId, student.studentProfileId));

  const due = (await engagementsDueForTermEndRefund(campus.institutionId)).find((row) => row.engagementId === engagementId)!;
  return [
    {
      key: "student-term-over",
      email: personaEmail(campus, "student-term-over"),
      role: "student",
      state: `${await describe(student)}, term ended ${ended.endsOn}, ${formatMinor(due.refundMinor)} refund waiting for the term-end sweep`,
    },
    {
      key: tutorKey,
      email: personaEmail(campus, tutorKey),
      role: "tutor",
      state: `${TERM_OVER_COURSE} at ${formatMinor(rateMinor)}, tutors student-term-over, payouts not set up`,
    },
  ];
}

export async function buildTermPersonas(campus: PersonaCampus): Promise<PersonaSummary[]> {
  return [...(await buildFinals(campus)), ...(await buildTermOver(campus))];
}
