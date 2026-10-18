import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, not, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  exam,
  matchRequest,
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
  asRequestedKind,
  bookAgainOpen,
  perSessionMinor,
  type PackageKind,
  type RequestedKind,
} from "@/server/modules/billing/pricing";
import { deferredMinor } from "@/server/modules/billing/ledger";
import { resumableUntil } from "@/server/modules/billing/checkout-window";
import { blockedBetween } from "@/server/modules/messaging/blocks";

import {
  bought,
  deliveredCount,
  heldAgainstPackage,
  liveEngagement,
  onCampus,
  sessionContext,
  loadParticipation,
  type Executor,
  type SessionContextRow,
} from "./access";
import {
  endBlock,
  sessionEndsAt,
  viewerAction,
  type EndBlock,
  type ViewerAction,
} from "./attendance";
import { releaseLapsedConfirmations } from "./confirmation";
import { sessionsRemaining } from "./scheduling";

export type SessionListItem = {
  sessionId: string;
  engagementId: string;
  scheduledAt: Date;
  durationMinutes: number;
  location: string | null;
  studentNote: string | null;
  status: SessionContextRow["status"];
  resolution: SessionContextRow["resolution"];
  confirmationWindowEndsAt: Date | null;
  checkoutLapsed: boolean;

  courseCode: string | null;
  courseTitle: string;
  section: string | null;
  professorName: string | null;

  otherPartyName: string;
  otherPartyRole: "student" | "tutor";
  action: ViewerAction;

  yourAnswer: Answer;
  threadId: string | null;
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
    location: row.location,
    studentNote: row.studentNote,
    status: row.status,
    resolution: row.resolution,
    confirmationWindowEndsAt: row.confirmationWindowEndsAt,
    checkoutLapsed:
      row.engagementStatus === "pending_payment" &&
      row.checkoutExpiresAt !== null &&
      resumableUntil(row.checkoutExpiresAt).getTime() <= now.getTime(),
    courseCode: row.courseCode,
    courseTitle: row.courseTitle,
    section: row.section,
    professorName: row.professorName,
    otherPartyName: viewer === "student" ? row.tutorName : row.studentName,
    otherPartyRole: otherSide(viewer),
    yourAnswer: answerFor(row, viewer),
    threadId: row.threadId,
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
        (item.status === "scheduled" || item.status === "held") &&
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
        ne(engagement.status, "cancelled"),
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
        bought,
        recentEnough,
      ),
    )
    .orderBy(desc(sessionBooking.scheduledAt));

  return board(rows, "tutor", now);
}

export type StudentPackage = {
  engagementId: string;
  tutorLocation: string | null;
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
  ending: PackageEnding;
};

export type PackageEnding = {
  refundMinor: number;
  cancels: Date[];
  blocked: EndBlock | null;
};

function remainingCount(): SQL<number> {
  return sql<number>`greatest(0, ${engagement.sessionsPurchased} - (${db
    .select({ n: sql`count(*)::int` })
    .from(sessionBooking)
    .where(and(eq(sessionBooking.engagementId, engagement.id), heldAgainstPackage()))}))`;
}

export type BookAgain = {
  tutorCourseId: string;
  offeringId: string;
  tutorProfileId: string;
  tutorName: string;
  tutorLocation: string | null;
  courseCode: string | null;
  courseTitle: string;
  currency: string;
  termEndsOn: string;
  sessionRateMinor: number;
  liveRequest: {
    id: string;
    status: "pending" | "accepted";
    requestedKind: RequestedKind | null;
  } | null;
};

export function bookAgainPath(tutorCourseId: string): string {
  return `/sessions?again=${tutorCourseId}`;
}

export function checkoutRestartPath(row: { matchRequestId: string | null; tutorCourseId: string }): string {
  return row.matchRequestId ? `/requests?buy=${row.matchRequestId}` : bookAgainPath(row.tutorCourseId);
}

export type PendingCheckout = {
  engagementId: string;
  matchRequestId: string | null;
  tutorCourseId: string;
  kind: PackageKind;
  amountMinor: number;
  currency: string;
  payBy: Date;
  lapsed: boolean;
  slot: Date | null;
  tutorName: string;
  courseCode: string | null;
  courseTitle: string;
  restartPath: string;
};

export async function pendingCheckoutsForStudent(actor: Actor): Promise<PendingCheckout[]> {
  const rows = await db
    .select({
      engagementId: engagement.id,
      matchRequestId: engagement.matchRequestId,
      tutorCourseId: engagement.tutorCourseId,
      kind: engagement.kind,
      amountMinor: engagement.pricePaidMinor,
      currency: engagement.currency,
      expiresAt: engagement.checkoutExpiresAt,
      slot: sessionBooking.scheduledAt,
      tutorName: user.name,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
    })
    .from(engagement)
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(user, eq(user.id, tutorProfile.userId))
    .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
    .innerJoin(course, eq(course.id, courseOffering.courseId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    )
    .leftJoin(
      sessionBooking,
      and(eq(sessionBooking.engagementId, engagement.id), eq(sessionBooking.status, "held")),
    )
    .where(
      and(
        eq(engagement.studentProfileId, actor.studentProfileId),
        eq(engagement.institutionId, actor.institutionId),
        eq(engagement.status, "pending_payment"),
        eq(tutorProfile.institutionId, actor.institutionId),
      ),
    )
    .orderBy(desc(engagement.createdAt));

  const now = Date.now();
  return rows.flatMap(({ expiresAt, ...row }) => {
    if (!expiresAt) return [];
    const payBy = resumableUntil(expiresAt);
    return [{ ...row, payBy, lapsed: payBy.getTime() <= now, restartPath: checkoutRestartPath(row) }];
  });
}

function termEndMoment(endsOn: string): Date {
  return new Date(`${endsOn}T12:00:00Z`);
}

export async function bookAgain(
  actor: Actor,
  tutorCourseId: string,
  exec: Executor = db,
): Promise<BookAgain | null> {
  return (await bookAgainRows(exec, actor, tutorCourseId)).at(0) ?? null;
}

export async function bookAgainList(actor: Actor): Promise<BookAgain[]> {
  return bookAgainRows(db, actor, null);
}

async function bookAgainRows(
  exec: Executor,
  actor: Actor,
  tutorCourseId: string | null,
): Promise<BookAgain[]> {
  const now = new Date();

  const pairs = await exec
    .select({
      tutorCourseId: engagement.tutorCourseId,
      offeringId: engagement.courseOfferingId,
      sessionsRemaining: sql<number>`coalesce(sum(${remainingCount()}) filter (where ${liveEngagement}), 0)::int`,
      tutorProfileId: tutorProfile.id,
      tutorName: user.name,
      tutorLocation: tutorProfile.defaultLocation,
      courseCode: courseCodeAlias.code,
      courseTitle: course.title,
      currency: sql<string>`min(${engagement.currency})`,
      termEndsOn: term.endsOn,
      sessionRateMinor: tutorCourse.sessionRateMinor,
    })
    .from(engagement)
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
        eq(engagement.institutionId, actor.institutionId),
        eq(tutorProfile.institutionId, actor.institutionId),
        tutorCourseId ? eq(engagement.tutorCourseId, tutorCourseId) : undefined,
        or(liveEngagement, eq(engagement.status, "completed")),
        gte(term.endsOn, sql`current_date`),
        eq(tutorCourse.status, "active"),
        ne(tutorProfile.userId, actor.userId),
        not(blockedBetween(tutorProfile.userId, actor.userId)),
      ),
    )
    .groupBy(
      engagement.tutorCourseId,
      engagement.courseOfferingId,
      tutorProfile.id,
      user.name,
      courseCodeAlias.code,
      course.title,
      term.endsOn,
      tutorCourse.sessionRateMinor,
    )
    .orderBy(desc(sql`max(${engagement.createdAt})`));

  const open = pairs.filter((pair) =>
    bookAgainOpen({
      sessionsRemaining: pair.sessionsRemaining,
      termEndsOn: termEndMoment(pair.termEndsOn),
      now,
    }),
  );
  if (open.length === 0) return [];

  const live = await exec
    .select({
      id: matchRequest.id,
      tutorCourseId: matchRequest.tutorCourseId,
      offeringId: matchRequest.courseOfferingId,
      status: matchRequest.status,
      requestedKind: matchRequest.requestedKind,
    })
    .from(matchRequest)
    .leftJoin(engagement, and(eq(engagement.matchRequestId, matchRequest.id), bought))
    .where(
      and(
        eq(matchRequest.studentProfileId, actor.studentProfileId),
        eq(matchRequest.institutionId, actor.institutionId),
        inArray(
          matchRequest.tutorCourseId,
          open.map((pair) => pair.tutorCourseId),
        ),
        inArray(matchRequest.status, ["pending", "accepted"]),
        or(ne(matchRequest.status, "pending"), gt(matchRequest.expiresAt, now)),
        isNull(engagement.id),
      ),
    )
    .orderBy(desc(matchRequest.createdAt));

  return open.map((pair) => {
    const request = live.find(
      (row) => row.tutorCourseId === pair.tutorCourseId && row.offeringId === pair.offeringId,
    );
    return {
      tutorCourseId: pair.tutorCourseId,
      offeringId: pair.offeringId,
      tutorProfileId: pair.tutorProfileId,
      tutorName: pair.tutorName,
      tutorLocation: pair.tutorLocation,
      courseCode: pair.courseCode,
      courseTitle: pair.courseTitle,
      currency: pair.currency,
      termEndsOn: pair.termEndsOn,
      sessionRateMinor: pair.sessionRateMinor,
      liveRequest: request
        ? {
            id: request.id,
            status: request.status as "pending" | "accepted",
            requestedKind: asRequestedKind(request.requestedKind),
          }
        : null,
    };
  });
}

export async function packagesForStudent(actor: Actor): Promise<StudentPackage[]> {
  const packages = await db
    .select({
      engagementId: engagement.id,
      kind: engagement.kind,
      sessionsPurchased: engagement.sessionsPurchased,
      sessionsDelivered: deliveredCount(engagement.id, engagement.institutionId),
      sessionsRemaining: remainingCount(),
      pricePaidMinor: engagement.pricePaidMinor,
      refundMinor: deferredMinor(engagement.id, engagement.institutionId),
      currency: engagement.currency,
      tutorName: user.name,
      tutorLocation: tutorProfile.defaultLocation,
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
  if (packages.length === 0) return [];

  const open = await db
    .select({
      engagementId: sessionBooking.engagementId,
      status: sessionBooking.status,
      scheduledAt: sessionBooking.scheduledAt,
    })
    .from(sessionBooking)
    .where(
      and(
        inArray(
          sessionBooking.engagementId,
          packages.map((pkg) => pkg.engagementId),
        ),
        eq(sessionBooking.institutionId, actor.institutionId),
        inArray(sessionBooking.status, ["scheduled", "disputed"]),
      ),
    )
    .orderBy(asc(sessionBooking.scheduledAt));

  const now = new Date();
  return packages.map(({ refundMinor, ...pkg }) => {
    const sessions = open.filter((row) => row.engagementId === pkg.engagementId);
    return {
      ...pkg,
      ending: {
        refundMinor,
        cancels: sessions
          .filter((row) => row.status === "scheduled")
          .map((row) => row.scheduledAt),
        blocked: endBlock(sessions, now),
      },
    };
  });
}

export type SessionDetail = SessionListItem & {
  courseId: string;
  tutorCourseId: string;
  termName: string;

  theirAnswer: Answer;

  denialNote: string | null;
  viewerRole: "student" | "tutor";
  sessionsPurchased: number;

  sessionsRemaining: number;
  sessionMinor: number;
  currency: string;
  lastInPackage: boolean;
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

  const [remaining, [others]] = await Promise.all([
    sessionsRemaining({ engagementId: row.engagementId, sessionsPurchased: row.sessionsPurchased }),
    db
      .select({ open: sql<number>`count(*)::int` })
      .from(sessionBooking)
      .where(
        and(
          eq(sessionBooking.engagementId, row.engagementId),
          eq(sessionBooking.institutionId, row.institutionId),
          ne(sessionBooking.id, row.sessionId),
          inArray(sessionBooking.status, ["held", "scheduled", "disputed"]),
        ),
      ),
  ]);

  return {
    ...toListItem(row, row.role, now),
    courseId: row.courseId,
    tutorCourseId: row.tutorCourseId,
    termName: row.termName,
    theirAnswer: answerFor(row, otherSide(row.role)),
    denialNote: row.denialNote,
    viewerRole: row.role,
    sessionsPurchased: row.sessionsPurchased,
    sessionsRemaining: remaining,
    sessionMinor: perSessionMinor(row),
    currency: row.currency,
    lastInPackage: remaining === 0 && others.open === 0,
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
