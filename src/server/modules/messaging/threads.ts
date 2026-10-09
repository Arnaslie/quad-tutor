import { and, desc, eq, gt, gte, isNull, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  courseOffering,
  engagement,
  matchRequest,
  message,
  messageThread,
  studentProfile,
  term,
  tutorCourse,
  tutorProfile,
  user,
  userBlock,
} from "@/server/db/schema";
import { bought, liveEngagement, tutorUser, type Executor } from "@/server/modules/engagements/access";
import { bookAgain, bookAgainPath } from "@/server/modules/engagements/reads";
import type { Actor } from "@/server/modules/identity/actor";
import { displayName } from "@/server/modules/identity/display-name";

import { blockedBetween, setBlock } from "./blocks";
import { DELETED_USER, SENDS_PER_HOUR, otherSide, previewLine, type ThreadSide } from "./rules";

export class MessagingError extends Error {}

export const threadStudentUser = sql`(
  select ${studentProfile.userId} from ${studentProfile}
  where ${studentProfile.id} = ${messageThread.studentProfileId}
)`;

export const threadTutorUser = sql`(
  select ${tutorProfile.userId} from ${tutorCourse}
  inner join ${tutorProfile} on ${tutorProfile.id} = ${tutorCourse.tutorProfileId}
  where ${tutorCourse.id} = ${messageThread.tutorCourseId}
)`;

export const threadBlocked = blockedBetween(threadStudentUser, threadTutorUser);

export const threadOpen = sql<boolean>`(
  exists (
    select 1 from ${matchRequest}
    inner join ${courseOffering} on ${courseOffering.id} = ${matchRequest.courseOfferingId}
    inner join ${term} on ${term.id} = ${courseOffering.termId}
    where ${matchRequest.studentProfileId} = ${messageThread.studentProfileId}
      and ${matchRequest.tutorCourseId} = ${messageThread.tutorCourseId}
      and (
        (${matchRequest.status} = 'pending' and ${matchRequest.expiresAt} > now())
        or (
          ${matchRequest.status} = 'accepted'
          and ${term.endsOn} >= current_date
          and not exists (
            select 1 from ${engagement}
            where ${engagement.matchRequestId} = ${matchRequest.id} and ${bought}
          )
        )
      )
  )
  or exists (
    select 1 from ${engagement}
    where ${engagement.studentProfileId} = ${messageThread.studentProfileId}
      and ${engagement.tutorCourseId} = ${messageThread.tutorCourseId}
      and ${liveEngagement}
  )
)`;

export function readThroughColumn(side: ThreadSide) {
  return side === "student" ? messageThread.studentReadThrough : messageThread.tutorReadThrough;
}

export function unreadFor(side: ThreadSide, until?: SQLWrapper): SQL {
  return sql`exists (
    select 1 from ${message}
    where ${message.threadId} = ${messageThread.id}
      and ${message.senderSide} = ${otherSide(side)}
      and ${message.createdAt} > coalesce(${readThroughColumn(side)}, '-infinity')
      ${until ? sql`and ${message.createdAt} <= ${until}` : sql``}
  )`;
}

function participantOf(actor: Actor): SQL | undefined {
  return and(
    eq(messageThread.institutionId, actor.institutionId),
    or(
      eq(messageThread.studentProfileId, actor.studentProfileId),
      actor.tutorProfileId ? eq(tutorCourse.tutorProfileId, actor.tutorProfileId) : undefined,
    ),
  );
}

function sideFor(actor: Actor, studentProfileId: string): ThreadSide {
  return studentProfileId === actor.studentProfileId ? "student" : "tutor";
}

export const courseLabel = sql<string>`coalesce(${courseCodeAlias.code}, ${course.title})`;

function threadRows<E extends Record<string, SQL>>(exec: Executor = db, extra = {} as E) {
  return exec
    .select({
      ...extra,
      id: messageThread.id,
      studentProfileId: messageThread.studentProfileId,
      tutorCourseId: messageThread.tutorCourseId,
      studentName: user.name,
      tutorName: tutorUser.name,
      courseLabel,
      open: threadOpen,
      blocked: sql<boolean>`${threadBlocked}`,
    })
    .from(messageThread)
    .innerJoin(tutorCourse, eq(tutorCourse.id, messageThread.tutorCourseId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .innerJoin(studentProfile, eq(studentProfile.id, messageThread.studentProfileId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .leftJoin(user, eq(user.id, studentProfile.userId))
    .leftJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .leftJoin(
      courseCodeAlias,
      and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)),
    );
}

type ThreadRow = Awaited<ReturnType<typeof threadRows>>[number];

function partyName(name: string | null, side: ThreadSide): string {
  return name === null ? DELETED_USER : displayName(name, side);
}

async function loadThread(exec: Executor, actor: Actor, threadId: string) {
  const row = (
    await threadRows(exec)
      .where(and(eq(messageThread.id, threadId), participantOf(actor)))
      .limit(1)
  ).at(0);
  if (!row) throw new MessagingError("That conversation does not exist.");
  return { ...row, side: sideFor(actor, row.studentProfileId) };
}

export function participantThread(actor: Actor, threadId: string) {
  return loadThread(db, actor, threadId);
}

export async function openThreads(
  exec: Executor,
  pairs: { studentProfileId: string; tutorCourseId: string; institutionId: string }[],
): Promise<void> {
  if (pairs.length === 0) return;
  await exec.insert(messageThread).values(pairs).onConflictDoNothing();
}

export type ThreadMessage = {
  id: string;
  mine: boolean;
  senderName: string;
  body: string;
  sentAt: Date;
};

export type ThreadView = {
  id: string;
  side: ThreadSide;
  otherName: string;
  courseLabel: string;
  open: boolean;
  blocked: boolean;
  blockedByMe: boolean;
  bookAgainHref: string | null;
  messages: ThreadMessage[];
};

const HISTORY_LIMIT = 200;

export async function messagesFor(
  exec: Executor,
  thread: Pick<ThreadRow, "id" | "studentName" | "tutorName">,
  viewerSide: ThreadSide | null,
): Promise<ThreadMessage[]> {
  const rows = await exec
    .select({
      id: message.id,
      senderSide: message.senderSide,
      senderUserId: message.senderUserId,
      body: message.body,
      sentAt: message.createdAt,
    })
    .from(message)
    .where(eq(message.threadId, thread.id))
    .orderBy(desc(message.createdAt))
    .limit(HISTORY_LIMIT);

  return rows.reverse().map((row) => ({
    id: row.id,
    mine: row.senderSide === viewerSide,
    senderName:
      row.senderUserId === null
        ? DELETED_USER
        : partyName(row.senderSide === "student" ? thread.studentName : thread.tutorName, row.senderSide),
    body: row.body,
    sentAt: row.sentAt,
  }));
}

export async function threadView(actor: Actor, threadId: string): Promise<ThreadView> {
  const thread = await loadThread(db, actor, threadId);
  const side = thread.side;
  const read = readThroughColumn(side);

  await db
    .update(messageThread)
    .set({
      [side === "student" ? "studentReadThrough" : "tutorReadThrough"]: sql`greatest(${read}, (
        select max(${message.createdAt}) from ${message}
        where ${message.threadId} = ${messageThread.id} and ${message.senderSide} = ${otherSide(side)}
      ))`,
    })
    .where(eq(messageThread.id, thread.id));

  const [messages, blockedByMe] = await Promise.all([
    messagesFor(db, thread, side),
    thread.blocked ? blockedByViewer(actor, thread) : false,
  ]);

  return {
    id: thread.id,
    side,
    otherName: partyName(side === "student" ? thread.tutorName : thread.studentName, otherSide(side)),
    courseLabel: thread.courseLabel,
    open: thread.open,
    blocked: thread.blocked,
    blockedByMe,
    bookAgainHref: side === "student" ? await bookAgainHref(actor, thread) : null,
    messages,
  };
}

async function blockedByViewer(actor: Actor, thread: ThreadRow): Promise<boolean> {
  const other = await otherUserId(thread, sideFor(actor, thread.studentProfileId));
  if (!other) return false;
  const rows = await db
    .select({ one: sql`1` })
    .from(userBlock)
    .where(and(eq(userBlock.blockerUserId, actor.userId), eq(userBlock.blockedUserId, other)))
    .limit(1);
  return rows.length > 0;
}

async function otherUserId(
  thread: Pick<ThreadRow, "studentProfileId" | "tutorCourseId">,
  side: ThreadSide,
): Promise<string | null> {
  const rows =
    side === "student"
      ? await db
          .select({ userId: tutorProfile.userId })
          .from(tutorCourse)
          .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
          .where(eq(tutorCourse.id, thread.tutorCourseId))
      : await db
          .select({ userId: studentProfile.userId })
          .from(studentProfile)
          .where(eq(studentProfile.id, thread.studentProfileId));
  return rows.at(0)?.userId ?? null;
}

async function bookAgainHref(
  actor: Actor,
  thread: Pick<ThreadRow, "tutorCourseId" | "open">,
): Promise<string | null> {
  if (await bookAgain(actor, thread.tutorCourseId)) return bookAgainPath(thread.tutorCourseId);
  if (thread.open) return null;

  const offering = await db
    .select({ id: matchRequest.courseOfferingId })
    .from(matchRequest)
    .innerJoin(courseOffering, eq(courseOffering.id, matchRequest.courseOfferingId))
    .innerJoin(term, eq(term.id, courseOffering.termId))
    .where(
      and(
        eq(matchRequest.studentProfileId, actor.studentProfileId),
        eq(matchRequest.institutionId, actor.institutionId),
        eq(matchRequest.tutorCourseId, thread.tutorCourseId),
        gte(term.endsOn, sql`current_date`),
      ),
    )
    .orderBy(desc(matchRequest.createdAt))
    .limit(1);

  const current = offering.at(0);
  return current ? `/courses/${current.id}` : "/courses";
}

export async function blockThread(params: {
  actor: Actor;
  threadId: string;
  blocked: boolean;
}): Promise<void> {
  const thread = await loadThread(db, params.actor, params.threadId);
  const other = await otherUserId(thread, thread.side);
  if (!other) throw new MessagingError("That person no longer has an account.");
  await setBlock({
    blockerUserId: params.actor.userId,
    blockedUserId: other,
    institutionId: params.actor.institutionId,
    blocked: params.blocked,
  });
}

export async function sendMessage(params: {
  actor: Actor;
  threadId: string;
  body: string;
}): Promise<{ recipient: ThreadSide }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`message-send:${params.actor.userId}`}))`);

    const thread = await loadThread(tx, params.actor, params.threadId);
    if (thread.blocked) throw new MessagingError("You can't message each other in this conversation.");
    if (!thread.open) throw new MessagingError("This conversation is closed. Book again to reopen it.");

    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(message)
      .where(
        and(
          eq(message.senderUserId, params.actor.userId),
          gt(message.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    if (recent.n >= SENDS_PER_HOUR) {
      throw new MessagingError("You've sent a lot of messages this hour. Try again a little later.");
    }

    await tx.insert(message).values({
      institutionId: params.actor.institutionId,
      threadId: thread.id,
      senderSide: thread.side,
      senderUserId: params.actor.userId,
      body: params.body,
    });

    return { recipient: otherSide(thread.side) };
  });
}

export type InboxItem = {
  id: string;
  otherName: string;
  courseLabel: string;
  side: ThreadSide;
  preview: string | null;
  lastAt: Date | null;
  unread: number;
};

function unreadCount(actor: Actor) {
  return sql<number>`(
    select count(*)::int from ${message}
    where ${message.threadId} = ${messageThread.id}
      and case when ${messageThread.studentProfileId} = ${actor.studentProfileId}
        then ${message.senderSide} = 'tutor'
          and ${message.createdAt} > coalesce(${messageThread.studentReadThrough}, '-infinity')
        else ${message.senderSide} = 'student'
          and ${message.createdAt} > coalesce(${messageThread.tutorReadThrough}, '-infinity')
      end
  )`;
}

export async function inboxFor(actor: Actor): Promise<InboxItem[]> {
  const lastBody = sql<string | null>`(
    select ${message.body} from ${message}
    where ${message.threadId} = ${messageThread.id}
    order by ${message.createdAt} desc limit 1
  )`;
  const lastAt = sql<Date | null>`(
    select max(${message.createdAt}) from ${message} where ${message.threadId} = ${messageThread.id}
  )`.mapWith(messageThread.createdAt);

  const rows = await threadRows(db, { lastBody, lastAt, unread: unreadCount(actor) })
    .where(participantOf(actor))
    .orderBy(desc(sql`coalesce(${lastAt}, ${messageThread.createdAt})`));

  return rows
    .filter((row) => row.lastAt !== null || row.open)
    .map((row) => {
      const side = sideFor(actor, row.studentProfileId);
      return {
        id: row.id,
        side,
        otherName: partyName(side === "student" ? row.tutorName : row.studentName, otherSide(side)),
        courseLabel: row.courseLabel,
        preview: row.lastBody ? previewLine(row.lastBody) : null,
        lastAt: row.lastAt,
        unread: row.unread,
      };
    });
}

export async function unreadTotal(actor: Actor): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${unreadCount(actor)}), 0)::int` })
    .from(messageThread)
    .innerJoin(tutorCourse, eq(tutorCourse.id, messageThread.tutorCourseId))
    .where(participantOf(actor));
  return row?.n ?? 0;
}
