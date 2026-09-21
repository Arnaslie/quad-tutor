import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  exam,
  professor,
  sessionBooking,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";
import {
  topUpOption,
  topUpWindowOpen,
  type PackageKind,
} from "@/server/modules/billing/pricing";

import {
  onCampus,
  sessionContext,
  loadParticipation,
  type SessionContextRow,
} from "./access";
import { sessionEndsAt, viewerAction, type ViewerAction } from "./attendance";
import { releaseLapsedConfirmations } from "./confirmation";
import { sessionsRemaining } from "./scheduling";

export type SessionListItem = {
  sessionId: string;
  engagementId: string;
  scheduledAt: Date;
  durationMinutes: number;
  locationNote: string | null;
  status: SessionContextRow["status"];
  resolution: SessionContextRow["resolution"];
  confirmationWindowEndsAt: Date | null;

  courseCode: string | null;
  courseTitle: string;
  section: string | null;
  professorName: string | null;

  otherPartyName: string;
  otherPartyRole: "student" | "tutor";
  action: ViewerAction;

  yourAnswer: Answer;
};

export type Answer = "confirmed" | "denied" | null;

function answerFor(row: SessionContextRow, viewer: "student" | "tutor"): Answer {
  const confirmed =
    viewer === "student" ? row.studentConfirmedAt : row.tutorConfirmedAt;
  const denied = viewer === "student" ? row.studentDeniedAt : row.tutorDeniedAt;

  if (confirmed) return "confirmed";
  if (denied) return "denied";
  return null;
}

const otherSide = (viewer: "student" | "tutor") =>
  viewer === "student" ? ("tutor" as const) : ("student" as const);

export type SessionBoard = {
  awaitingAnswer: SessionListItem[];

  upcoming: SessionListItem[];

  past: SessionListItem[];
};

function toListItem(
  row: SessionContextRow,
  viewer: "student" | "tutor",
  now: Date,
): SessionListItem {
  return {
    sessionId: row.sessionId,
    engagementId: row.engagementId,
    scheduledAt: row.scheduledAt,
    durationMinutes: row.durationMinutes,
    locationNote: row.locationNote,
    status: row.status,
    resolution: row.resolution,
    confirmationWindowEndsAt: row.confirmationWindowEndsAt,
    courseCode: row.courseCode,
    courseTitle: row.courseTitle,
    section: row.section,
    professorName: row.professorName,
    otherPartyName: viewer === "student" ? row.tutorName : row.studentName,
    otherPartyRole: otherSide(viewer),
    yourAnswer: answerFor(row, viewer),
    action: viewerAction({
      status: row.status,
      scheduledAt: row.scheduledAt,
      durationMinutes: row.durationMinutes,
      answers: row,
      viewer,
      now,
    }),
  };
}

const PAST_LIMIT = 50;

const recentEnough = sql`(
  ${sessionBooking.status} = 'scheduled'
  or ${sessionBooking.scheduledAt} > now() - interval '200 days'
)`;

async function board(
  rows: SessionContextRow[],
  viewer: "student" | "tutor",
  now: Date,
): Promise<SessionBoard> {
  const items = rows.map((row) => toListItem(row, viewer, now));

  const awaitingAnswer = items.filter((item) => item.action === "confirm_or_deny");
  const upcoming = items
    .filter(
      (item) =>
        item.status === "scheduled" &&
        item.action !== "confirm_or_deny" &&
        now.getTime() < sessionEndsAt(item.scheduledAt, item.durationMinutes).getTime(),
    )
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());

  const settled = new Set([...awaitingAnswer, ...upcoming].map((item) => item.sessionId));
  const past = items
    .filter((item) => !settled.has(item.sessionId))
    .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())
    .slice(0, PAST_LIMIT);

  return { awaitingAnswer, upcoming, past };
}

export async function sessionBoardForStudent(actor: Actor): Promise<SessionBoard> {
  await releaseLapsedConfirmations();
  const now = new Date();

  const rows = await sessionContext()
    .where(
      and(
        eq(studentProfile.id, actor.studentProfileId),
        onCampus(actor.institutionId),
        recentEnough,
      ),
    )
    .orderBy(desc(sessionBooking.scheduledAt));

  return board(rows, "student", now);
}

export async function sessionBoardForTutor(tutor: TutorActor): Promise<SessionBoard> {
  await releaseLapsedConfirmations();
  const now = new Date();

  const rows = await sessionContext()
    .where(
      and(
        eq(tutorProfile.id, tutor.tutorProfileId),
        onCampus(tutor.institutionId),
        recentEnough,
      ),
    )
    .orderBy(desc(sessionBooking.scheduledAt));

  return board(rows, "tutor", now);
}

export type StudentPackage = {
  engagementId: string;
  kind: PackageKind;
  sessionsPurchased: number;

  sessionsDelivered: number;

  sessionsRemaining: number;
  pricePaidMinor: number;
  currency: string;
  tutorName: string;
  courseCode: string | null;
  courseTitle: string;
  section: string | null;
  professorName: string | null;
  anchorExamName: string | null;
  anchorExamOccursOn: string | null;
};

const deliveredCount = sql<number>`(
  select count(*)::int from ${sessionBooking}
  where ${sessionBooking.engagementId} = ${engagement.id}
    and ${sessionBooking.status} = 'completed'
)`;

const remainingCount = sql<number>`greatest(0, ${engagement.sessionsPurchased} - (
  select count(*)::int from ${sessionBooking}
  where ${sessionBooking.engagementId} = ${engagement.id}
    and ${sessionBooking.status} <> 'cancelled'
))`;

export type TopUpCandidate = {
  engagementId: string;
  tutorName: string;
  courseCode: string | null;
  courseTitle: string;
  priceMinor: number;
  currency: string;
  termEndsOn: string;
};

export async function topUpCandidates(actor: Actor): Promise<TopUpCandidate[]> {
  const now = new Date();

  const rows = await db
    .select({
      engagementId: engagement.id,
      sessionsRemaining: remainingCount,
      tutorName: user.name,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      currency: engagement.currency,
      termEndsOn: term.endsOn,
    })
    .from(engagement)

    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .where(
      and(
        eq(engagement.studentProfileId, actor.studentProfileId),

        inArray(engagement.status, ["active", "completed"]),
        onCampus(actor.institutionId),
      ),
    )
    .orderBy(desc(engagement.createdAt));

  const option = topUpOption();

  return rows
    .filter((row) =>
      topUpWindowOpen({
        sessionsRemaining: row.sessionsRemaining,

        termEndsOn: new Date(`${row.termEndsOn}T12:00:00Z`),
        now,
      }),
    )
    .map((row) => ({
      engagementId: row.engagementId,
      tutorName: row.tutorName,
      courseCode: row.courseCode,
      courseTitle: row.courseTitle,
      priceMinor: option.priceMinor,
      currency: row.currency,
      termEndsOn: row.termEndsOn,
    }));
}

export async function packagesForStudent(actor: Actor): Promise<StudentPackage[]> {
  return db
    .select({
      engagementId: engagement.id,
      kind: engagement.kind,
      sessionsPurchased: engagement.sessionsPurchased,
      sessionsDelivered: deliveredCount,
      sessionsRemaining: remainingCount,
      pricePaidMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
      tutorName: user.name,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      section: courseOffering.section,
      professorName: professor.name,
      anchorExamName: exam.name,
      anchorExamOccursOn: exam.occursOn,
    })
    .from(engagement)
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))

    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .leftJoin(professor, eq(professor.id, courseOffering.professorId))
    .leftJoin(exam, eq(exam.id, engagement.anchorExamId))
    .where(
      and(
        eq(engagement.studentProfileId, actor.studentProfileId),
        eq(engagement.status, "active"),
        onCampus(actor.institutionId),
      ),
    )
    .orderBy(asc(exam.occursOn), desc(engagement.createdAt));
}

export type SessionDetail = SessionListItem & {
  courseId: string;
  termName: string;

  theirAnswer: Answer;

  denialNote: string | null;
  viewerRole: "student" | "tutor";
  sessionsPurchased: number;

  sessionsRemaining: number;
};

export async function sessionDetail(params: {
  actor: Actor;
  sessionId: string;
}): Promise<SessionDetail> {
  await releaseLapsedConfirmations();
  const now = new Date();

  const row = await loadParticipation({
    sessionId: params.sessionId,
    actor: params.actor,
  });

  return {
    ...toListItem(row, row.role, now),
    courseId: row.courseId,
    termName: row.termName,
    theirAnswer: answerFor(row, otherSide(row.role)),
    denialNote: row.denialNote,
    viewerRole: row.role,
    sessionsPurchased: row.sessionsPurchased,
    sessionsRemaining: await sessionsRemaining({
      engagementId: row.engagementId,
      sessionsPurchased: row.sessionsPurchased,
    }),
  };
}

/** Superseded by notifications/dispatch.ts; kept for operator inspection. */
export async function remindersDue(institutionId: string): Promise<SessionListItem[]> {
  const now = new Date();
  const horizon = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const rows = await sessionContext()
    .where(
      and(
        eq(sessionBooking.status, "scheduled"),
        gte(sessionBooking.scheduledAt, now),
        lte(sessionBooking.scheduledAt, horizon),
        onCampus(institutionId),
      ),
    )
    .orderBy(asc(sessionBooking.scheduledAt));

  return rows.map((row) => toListItem(row, "student", now));
}
