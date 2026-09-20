/**
 * Everything the session screens read. One query per screen, authorised
 * against the actor, with the tenant key taken from the signed-in user and
 * never from an argument.
 *
 * Two shaping decisions worth knowing before building against these:
 *
 *   - A session that has finished but not been answered is returned in its own
 *     bucket, not filed under "past". It is the most actionable thing either
 *     party has, and burying it where nobody looks is how a confirmation
 *     window lapses — prevention comes before penalty, and a visible prompt is
 *     the cheapest prevention there is.
 *   - `action` is computed by the pure `viewerAction`, not by the UI. The
 *     student view and the tutor view are the same function with a different
 *     viewer, so they cannot drift apart.
 *
 * Every read sweeps lapsed confirmations first, matching `expireStaleRequests`
 * in the matching module: no cron, and every path that cares calls it.
 */

import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";

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
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import type { Actor, TutorActor } from "@/server/modules/identity/actor";

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
  /** The course code as it is written this term, and who teaches it. */
  courseCode: string | null;
  courseTitle: string;
  section: string | null;
  professorName: string | null;
  /** Whoever the viewer is not. */
  otherPartyName: string;
  otherPartyRole: "student" | "tutor";
  action: ViewerAction;
  /**
   * What this viewer said, if anything — their side of the row, not both.
   *
   * `action` alone cannot carry this: `awaiting_other_party` is the same value
   * whether you confirmed the session or said it never happened, and those are
   * materially different things to have clicked. Without it a card can only
   * say "you have answered", and someone who mis-clicked has no way to notice.
   */
  yourAnswer: Answer;
};

export type Answer = "confirmed" | "denied" | null;

/**
 * Which of the four timestamps belongs to whom. One definition, used by the
 * board and by the detail read — the mapping is exactly the kind of thing that
 * rots when a component keeps its own copy.
 */
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

/**
 * One call, three buckets, one query. A student has a handful of sessions and
 * a tutor at campus scale has dozens, so paging is a problem this product does
 * not have yet; `past` is capped rather than paged.
 */
export type SessionBoard = {
  /** Finished, unanswered by this viewer. Show these first. */
  awaitingAnswer: SessionListItem[];
  /** Still to come, soonest first. */
  upcoming: SessionListItem[];
  /** Settled: delivered, cancelled, or waiting on a human. Newest first. */
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

/**
 * Anything still scheduled, plus a term's worth of history. Bounded so a
 * fourth-semester tutor's list does not grow without limit.
 */
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

/** Every session in this student's packages, bucketed. */
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

/** The same, from the other side of the table. */
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

/**
 * A package as the student's own screens need it: what they bought, what is
 * left of it, who it is with and which exam it points at.
 *
 * `sessionBoardForStudent` answers "what is on my calendar"; this answers
 * "what have I paid for". They are different questions and a student who
 * cancels their only booked session still has a package — without this read
 * there is nowhere to show it, and no route back to booking.
 */
export type StudentPackage = {
  engagementId: string;
  kind: "exam_anchored" | "through_final";
  sessionsPurchased: number;
  /** Booked or delivered; a cancelled session is not one of these. */
  sessionsDelivered: number;
  /** Left to book. Not `purchased - delivered`: a session can be on the
   *  calendar and not yet held, which is neither. */
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

/**
 * Every package this student currently holds, soonest exam first.
 *
 * Active only: a completed or refunded package is history, and history is what
 * the session board's `past` bucket is for.
 */
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
    // Left joins for the same reason as in `access.ts`: a course between
    // renumberings, an offering with no professor yet, or a package with no
    // anchor exam must not make someone's paid package disappear.
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
  /** `yourAnswer` is inherited from `SessionListItem`; the detail view adds
   *  theirs. Both sides see both — a confirmation that is invisible to the
   *  other party is a dispute waiting to happen. */
  theirAnswer: Answer;
  /** Only ever set on a session someone denied; what the reviewer reads. */
  denialNote: string | null;
  viewerRole: "student" | "tutor";
  sessionsPurchased: number;
  /** Left to book in this package. A cancelled session is back in here. */
  sessionsRemaining: number;
};

/**
 * One session, with the course, the professor, the other party, the
 * confirmation state and the single thing this caller can do about it.
 */
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

/**
 * The T-12h nudge. Prevention is the first line of the reliability system and
 * the ordering — confirm, then auto-release, then anything that costs a
 * student something — is a product principle, not a preference.
 *
 * TODO(notifications): this is the seam. There is no delivery channel and no
 * `reminded_at` column yet, so this returns what a reminder job would send and
 * nothing dedupes it. Both are the same small piece of work, and neither
 * belongs in this draft.
 */
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

