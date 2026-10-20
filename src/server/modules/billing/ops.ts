import { and, desc, eq, exists, inArray, isNotNull, isNull, ne, not, notExists, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import {
  course,
  courseCodeAlias,
  engagement,
  ledgerEntry,
  ledgerEntryType,
  moneyDiscrepancy,
  moneyDiscrepancyKind,
  paymentDispute,
  sessionBooking,
  studentProfile,
  tutorCourse,
  tutorProfile,
  user,
} from "@/server/db/schema";
import { tutorUser } from "@/server/modules/engagements/access";
import type { OperatorActor } from "@/server/modules/identity/actor";
import { DELETED_USER } from "@/server/modules/messaging/rules";
import { courseLabel } from "@/server/modules/messaging/threads";

import { purchaseBooked, retriesRefund, uniqueViolation } from "./checkout-session";
import { FORFEITED_PREFIX, MANUAL_PREFIX, paymentRefundBlocker, type Ids } from "./discrepancy";
import { formatMinor } from "./pricing";
import { blockedRefunds, heldBy, heldByFlags, stoppedForGood } from "./refunds";
import { blockedEngagements, paused } from "./transfers";

type DiscrepancyKind = (typeof moneyDiscrepancyKind.enumValues)[number];
type LedgerType = (typeof ledgerEntryType.enumValues)[number];

export type EngagementContext = { courseLabel: string; tutorName: string; studentName: string };

/** Which refund or transfer a card is about: its amount, when it was booked, and the session it is for, if any. */
export type RowFacts = { id: string; amountMinor: number; bookedAt: Date; sessionAt: Date | null };

export type DiscrepancyItem = {
  id: string;
  kind: Exclude<DiscrepancyKind, "orphaned_account">;
  /** Null when the flag is keyed on our own id (a transfers gap, a failed refund row) rather than a Stripe object. */
  stripeReference: string | null;
  /** The purchase's PaymentIntent, so a card keyed on our own id still names the payment. */
  paymentIntentId: string | null;
  refundReference: string | null;
  ledgerAmountMinor: number | null;
  stripeAmountMinor: number | null;
  currency: string;
  detectedAt: Date;
  /** The row the flag names. A Dashboard refund booked onto it may be for a different amount. */
  row: (RowFacts & { type: LedgerType; reference: string | null }) | null;
  /** Unsent refunds a failed refund holds back from the card. Each is paid by hand on its own. */
  held: (RowFacts & { stoppedForGood: boolean })[];
  /** Ops' note from when they last answered this flag, which a failed refund reopening it keeps. Free text. */
  lastAnswer: string | null;
  engagement: EngagementContext | null;
  /** Settling stamps the unsent row the flag names. Held refunds are settled one by one instead. */
  canSettle: boolean;
  canResolve: boolean;
  paymentBooked: boolean;
  /**
   * What the flag does to a refund: its own keeps retrying while it is open or failed at Stripe, or it holds the
   * engagement's unsent refunds, one of which another flag may also have stopped for good.
   */
  refund: "retrying" | "failed" | "holding" | "holding_stopped" | null;
};

export type OrphanedAccountItem = { id: string; accountId: string; detectedAt: Date };

export type DisputeItem = {
  id: string;
  stripeDisputeId: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  engagement: EngagementContext | null;
  canLift: boolean;
};

export type ReversalItem = {
  id: string;
  amountMinor: number;
  currency: string;
  reference: string;
  bookedAt: Date;
  engagement: EngagementContext | null;
  paused: boolean;
};

export type MoneyForOperator = {
  discrepancies: DiscrepancyItem[];
  orphanedAccounts: OrphanedAccountItem[];
  disputes: DisputeItem[];
  reversals: ReversalItem[];
  held: { refunds: number; transfers: number };
};

type Refused<R extends string> = { ok: false; refusal: R };
const refused = <R extends string>(refusal: R): Refused<R> => ({ ok: false, refusal });
const DONE = { ok: true } as const;

export type ResolveResult = typeof DONE | Refused<"gone" | "settle_instead">;
export type SettleResult = typeof DONE | Refused<"gone" | "not_settleable">;
export type LiftResult = typeof DONE | Refused<"gone" | "open_at_stripe">;
export type ReversalAnswer = "resend" | "manual" | "forfeited";
/** `resend` names the new row, for the caller to send after the response. */
export type AnswerResult = { ok: true; resend: (Ids & { id: string }) | null } | Refused<"gone" | "answered" | "paused">;

const LIMIT = 100;
const namedRow = alias(ledgerEntry, "named_row");
const answer = alias(ledgerEntry, "answer");
const failedFlag = alias(moneyDiscrepancy, "failed_flag");
const settledRow = alias(ledgerEntry, "settled_row");
const paid = alias(ledgerEntry, "paid");

/** A refund or transfer row a discrepancy stopped before Stripe stamped it. */
const namesUnstampedRow = () =>
  exists(
    db
      .select({ id: namedRow.id })
      .from(namedRow)
      .where(
        and(
          eq(namedRow.id, moneyDiscrepancy.ledgerEntryId),
          eq(namedRow.institutionId, moneyDiscrepancy.institutionId),
          inArray(namedRow.type, ["refund", "tutor_transfer"]),
          isNull(namedRow.stripeReference),
        ),
      ),
  );

/** The flag is a failed refund holding one of the engagement's unsent refunds back from the card (`holdsRefund`). */
const holds = (where?: SQL) => sql<boolean>`exists(${heldBy(moneyDiscrepancy.id, where)})`;

/** Notes from paying held refunds one at a time, kept when the flag is answered. */
const answered = (note: string | SQL) =>
  sql`case when ${moneyDiscrepancy.resolutionNote} is not null and exists(${db
    .select({ id: settledRow.id })
    .from(settledRow)
    .where(
      and(
        eq(settledRow.institutionId, moneyDiscrepancy.institutionId),
        sql`${settledRow.stripeReference} like ${MANUAL_PREFIX} || ${moneyDiscrepancy.id}::text || ':%'`,
      ),
    )})
    then ${moneyDiscrepancy.resolutionNote} || E'\n' || ${note} else ${note} end`;

/**
 * The refund this flag is about failed at Stripe, and is answered on the payment's refund_failed flag: the refund of
 * money taken with nothing booked, or a Dashboard refund the flag names, which must never be booked as the package's.
 */
const refundFailed = () =>
  or(
    and(
      inArray(moneyDiscrepancy.kind, ["checkout_amount", "ledger_vs_stripe_charge"]),
      exists(paymentRefundBlocker(moneyDiscrepancy.stripeReference, moneyDiscrepancy.institutionId)),
      not(purchaseBooked()),
    ),
    exists(
      db
        .select({ id: failedFlag.id })
        .from(failedFlag)
        .where(
          and(
            eq(failedFlag.kind, "refund_failed"),
            eq(failedFlag.institutionId, moneyDiscrepancy.institutionId),
            eq(failedFlag.engagementId, moneyDiscrepancy.engagementId),
            sql`${moneyDiscrepancy.stripeReference} = any(${failedFlag.failedRefundIds})`,
          ),
        ),
    ),
  );

const settleable = () => sql<boolean>`(${namesUnstampedRow()} and not ${refundFailed()})`;

/** Resolved, a row would stay unsent and unsettled for good: one the flag stopped, or a held one another flag stopped. */
const strandsRow = () => sql<boolean>`(${namesUnstampedRow()} or ${holds(sql`${stoppedForGood()}`)})`;

const answerTo = (reversalId: AnyColumn) => db.select({ id: answer.id }).from(answer).where(eq(answer.correctsEntryId, reversalId));

async function contexts(campuses: string[], engagementIds: string[]): Promise<Map<string, EngagementContext>> {
  if (engagementIds.length === 0) return new Map();
  const rows = await db
    .select({ id: engagement.id, courseLabel, tutorName: tutorUser.name, studentName: user.name })
    .from(engagement)
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .innerJoin(course, eq(course.id, tutorCourse.courseId))
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .leftJoin(user, eq(user.id, studentProfile.userId))
    .leftJoin(tutorUser, eq(tutorUser.id, tutorProfile.userId))
    .leftJoin(courseCodeAlias, and(eq(courseCodeAlias.courseId, course.id), isNull(courseCodeAlias.validToTermId)))
    .where(and(inArray(engagement.id, engagementIds), inArray(engagement.institutionId, campuses)));
  return new Map(
    rows.map((row) => [
      row.id,
      { courseLabel: row.courseLabel, tutorName: row.tutorName ?? DELETED_USER, studentName: row.studentName ?? DELETED_USER },
    ]),
  );
}

export async function moneyForOperator(operator: OperatorActor): Promise<MoneyForOperator> {
  const campuses = operator.operatorInstitutionIds;
  const open = and(inArray(moneyDiscrepancy.institutionId, campuses), isNull(moneyDiscrepancy.resolvedAt));
  const [flags, orphans, disputes, reversals, refundsHeld, transfersHeld] = await Promise.all([
    db
      .select({
        id: moneyDiscrepancy.id,
        kind: moneyDiscrepancy.kind,
        engagementId: moneyDiscrepancy.engagementId,
        stripeReference: sql<string | null>`nullif(nullif(${moneyDiscrepancy.stripeReference}, ${moneyDiscrepancy.engagementId}::text), ${moneyDiscrepancy.ledgerEntryId}::text)`,
        paymentIntentId: sql<string | null>`(${db
          .select({ reference: paid.stripeReference })
          .from(paid)
          .where(
            and(
              eq(paid.engagementId, moneyDiscrepancy.engagementId),
              eq(paid.institutionId, moneyDiscrepancy.institutionId),
              eq(paid.type, "package_purchase"),
            ),
          )
          .limit(1)})`,
        refundReference: moneyDiscrepancy.refundReference,
        ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor,
        stripeAmountMinor: moneyDiscrepancy.stripeAmountMinor,
        currency: moneyDiscrepancy.currency,
        detectedAt: moneyDiscrepancy.detectedAt,
        rowId: ledgerEntry.id,
        rowType: ledgerEntry.type,
        rowMinor: ledgerEntry.amountMinor,
        rowBookedAt: ledgerEntry.occurredAt,
        rowSessionAt: sessionBooking.scheduledAt,
        rowReference: ledgerEntry.stripeReference,
        lastAnswer: moneyDiscrepancy.resolutionNote,
        canSettle: settleable(),
        canResolve: sql<boolean>`not ${strandsRow()}`,
        paymentBooked: sql<boolean>`${purchaseBooked()}`,
        refund: sql<"retrying" | "failed" | null>`case when ${retriesRefund()} then 'retrying' when ${refundFailed()} then 'failed' end`,
      })
      .from(moneyDiscrepancy)
      .leftJoin(
        ledgerEntry,
        and(eq(ledgerEntry.id, moneyDiscrepancy.ledgerEntryId), eq(ledgerEntry.institutionId, moneyDiscrepancy.institutionId)),
      )
      .leftJoin(
        sessionBooking,
        and(eq(sessionBooking.id, ledgerEntry.sessionId), eq(sessionBooking.institutionId, ledgerEntry.institutionId)),
      )
      .where(and(open, ne(moneyDiscrepancy.kind, "orphaned_account")))
      .orderBy(desc(moneyDiscrepancy.detectedAt))
      .limit(LIMIT),
    db
      .select({
        id: moneyDiscrepancy.id,
        accountId: sql<string>`${moneyDiscrepancy.stripeReference}`,
        detectedAt: moneyDiscrepancy.detectedAt,
      })
      .from(moneyDiscrepancy)
      .where(and(open, eq(moneyDiscrepancy.kind, "orphaned_account")))
      .orderBy(desc(moneyDiscrepancy.detectedAt))
      .limit(LIMIT),
    db
      .select({
        id: paymentDispute.id,
        stripeDisputeId: paymentDispute.stripeDisputeId,
        engagementId: paymentDispute.engagementId,
        amountMinor: paymentDispute.amountMinor,
        currency: paymentDispute.currency,
        reason: paymentDispute.reason,
        status: paymentDispute.status,
        openedAt: paymentDispute.openedAt,
        closedAt: paymentDispute.closedAt,
      })
      .from(paymentDispute)
      .where(and(inArray(paymentDispute.institutionId, campuses), isNull(paymentDispute.resolvedAt)))
      .orderBy(desc(paymentDispute.openedAt))
      .limit(LIMIT),
    db
      .select({
        id: ledgerEntry.id,
        engagementId: ledgerEntry.engagementId,
        amountMinor: ledgerEntry.amountMinor,
        currency: ledgerEntry.currency,
        reference: sql<string>`${ledgerEntry.stripeReference}`,
        bookedAt: ledgerEntry.occurredAt,
        paused: paused(ledgerEntry.engagementId, ledgerEntry.institutionId),
      })
      .from(ledgerEntry)
      .where(
        and(
          inArray(ledgerEntry.institutionId, campuses),
          eq(ledgerEntry.type, "transfer_reversal"),
          notExists(answerTo(ledgerEntry.id)),
        ),
      )
      .orderBy(desc(ledgerEntry.occurredAt))
      .limit(LIMIT),
    Promise.all(campuses.map(blockedRefunds)),
    Promise.all(campuses.map(blockedEngagements)),
  ]);

  const heldRows = await heldByFlags(flags.flatMap((flag) => (flag.kind === "refund_failed" ? [flag.id] : [])));
  const heldOn = (flagId: string) =>
    heldRows
      .filter((row) => row.flagId === flagId)
      .map(({ id, amountMinor, bookedAt, sessionAt, stoppedForGood }) => ({ id, amountMinor, bookedAt, sessionAt, stoppedForGood }));

  const context = await contexts(campuses, [
    ...new Set([...flags, ...disputes, ...reversals].flatMap((row) => (row.engagementId ? [row.engagementId] : []))),
  ]);
  const on = (engagementId: string) => context.get(engagementId) ?? null;
  const sum = (counts: number[]) => counts.reduce((total, n) => total + n, 0);

  return {
    discrepancies: flags.flatMap((flag) => {
      const { engagementId, kind, rowId, rowType, rowMinor, rowBookedAt, rowSessionAt, rowReference, refund, ...rest } = flag;
      if (kind === "orphaned_account") return [];
      const held = heldOn(flag.id);
      const row =
        rowId && rowType && rowMinor !== null && rowBookedAt
          ? { id: rowId, type: rowType, amountMinor: rowMinor, bookedAt: rowBookedAt, sessionAt: rowSessionAt, reference: rowReference }
          : null;
      const holding = held.some((h) => h.stoppedForGood) ? "holding_stopped" : held.length > 0 ? "holding" : null;
      return [{ ...rest, kind, row, held, refund: refund ?? holding, engagement: engagementId ? on(engagementId) : null }];
    }),
    orphanedAccounts: orphans,
    disputes: disputes.map(({ engagementId, ...dispute }) => ({
      ...dispute,
      engagement: on(engagementId),
      canLift: dispute.closedAt !== null,
    })),
    reversals: reversals.map(({ engagementId, ...reversal }) => ({ ...reversal, engagement: on(engagementId) })),
    held: { refunds: sum(refundsHeld), transfers: sum(transfersHeld) },
  };
}

const openOnCampus = (operator: OperatorActor, discrepancyId: string) =>
  and(
    eq(moneyDiscrepancy.id, discrepancyId),
    inArray(moneyDiscrepancy.institutionId, operator.operatorInstitutionIds),
    isNull(moneyDiscrepancy.resolvedAt),
  );

/**
 * Resolving lifts the engagement's pause but never re-arms a ledger row the discrepancy stopped. A flag naming a row
 * Stripe never stamped, or holding one another flag stopped, is refused: resolved, that row would stay unsent and
 * unsettled for good, so ops settles it.
 */
export async function resolveDiscrepancy(params: {
  operator: OperatorActor;
  discrepancyId: string;
  note: string;
}): Promise<ResolveResult> {
  const scope = openOnCampus(params.operator, params.discrepancyId);
  const resolved = await db
    .update(moneyDiscrepancy)
    .set({ resolvedAt: new Date(), resolutionNote: answered(params.note), resolvedByUserId: params.operator.userId })
    .where(and(scope, not(strandsRow())))
    .returning({ id: moneyDiscrepancy.id });
  if (resolved.length > 0) return DONE;
  const open = await db.select({ id: moneyDiscrepancy.id }).from(moneyDiscrepancy).where(scope);
  return refused(open.length > 0 ? "settle_instead" : "gone");
}

/**
 * Ops paid the student or the tutor another way. The row the flag names is stamped `manual:<discrepancy id>` in the
 * same transaction, so no sweep sees it again. A flag on a refund made in the Dashboard stamps the row with that
 * `re_…` instead: it is the refund that happened, and the reconciliation then counts it. Any gap between its amount
 * and the row's is ops' to settle. A failed refund that holds the engagement's other refunds pays them by hand one
 * at a time (`heldRefundId`): each is stamped `manual:<discrepancy id>:<row id>` with the operator, its note is
 * added to the flag's. A failed Dashboard refund resolves once it holds nothing more; a bounced row of ours still owes
 * its own refund, so ops resolves that one.
 */
export async function recordManualSettlement(params: {
  operator: OperatorActor;
  discrepancyId: string;
  note: string;
  heldRefundId?: string;
}): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const scope = openOnCampus(params.operator, params.discrepancyId);
    const [found] = await tx
      .select({
        institutionId: moneyDiscrepancy.institutionId,
        ledgerEntryId: moneyDiscrepancy.ledgerEntryId,
        stripeReference: moneyDiscrepancy.stripeReference,
        settleable: settleable(),
      })
      .from(moneyDiscrepancy)
      .where(scope)
      .for("update");
    if (!found) return refused("gone");

    const resolve = (where?: SQL) =>
      tx
        .update(moneyDiscrepancy)
        .set({ resolvedAt: new Date(), resolutionNote: answered(params.note), resolvedByUserId: params.operator.userId })
        .where(and(scope, where));

    if (params.heldRefundId) {
      const stillHeld = () => heldBy(sql`${params.discrepancyId}::uuid`);
      const [stamped] = await tx
        .update(ledgerEntry)
        .set({ stripeReference: `${MANUAL_PREFIX}${params.discrepancyId}:${params.heldRefundId}`, recordedByUserId: params.operator.userId })
        // The conditions on the row itself are checked again after a wait on its lock; the subquery is not.
        .where(
          and(
            eq(ledgerEntry.id, params.heldRefundId),
            eq(ledgerEntry.institutionId, found.institutionId),
            isNull(ledgerEntry.stripeReference),
            inArray(ledgerEntry.id, stillHeld()),
          ),
        )
        .returning({ amountMinor: ledgerEntry.amountMinor, currency: ledgerEntry.currency });
      // Stripe stamped the row since it was read: the money moved there, so settling by hand would pay twice.
      if (!stamped) return refused("not_settleable");
      const line = `${formatMinor(stamped.amountMinor, stamped.currency)}: ${params.note}`;
      await tx
        .update(moneyDiscrepancy)
        .set({ resolutionNote: sql`coalesce(${moneyDiscrepancy.resolutionNote} || E'\n', '') || ${line}` })
        .where(scope);
      // A bounced row of ours still owes its own refund, which ops answers by resolving.
      if (found.ledgerEntryId) return DONE;
      await tx
        .update(moneyDiscrepancy)
        .set({ resolvedAt: new Date(), resolvedByUserId: params.operator.userId })
        .where(and(scope, notExists(stillHeld())));
      return DONE;
    }

    if (!found.settleable || !found.ledgerEntryId) return refused("not_settleable");
    const stamped = await tx
      .update(ledgerEntry)
      .set({
        stripeReference: found.stripeReference?.startsWith("re_") ? found.stripeReference : `${MANUAL_PREFIX}${params.discrepancyId}`,
      })
      .where(
        and(
          eq(ledgerEntry.id, found.ledgerEntryId),
          eq(ledgerEntry.institutionId, found.institutionId),
          inArray(ledgerEntry.type, ["refund", "tutor_transfer"]),
          isNull(ledgerEntry.stripeReference),
        ),
      )
      .returning({ id: ledgerEntry.id });
    if (stamped.length === 0) return refused("not_settleable");
    await resolve();
    return DONE;
  });
}

/** Stripe closing a dispute does not lift the pause: what a lost one means for the tutor's pay is ops' call. */
export async function liftDisputePause(params: {
  operator: OperatorActor;
  disputeId: string;
  note: string;
}): Promise<LiftResult> {
  const scope = and(
    eq(paymentDispute.id, params.disputeId),
    inArray(paymentDispute.institutionId, params.operator.operatorInstitutionIds),
    isNull(paymentDispute.resolvedAt),
  );
  const lifted = await db
    .update(paymentDispute)
    .set({ resolvedAt: new Date(), resolutionNote: params.note, resolvedByUserId: params.operator.userId })
    .where(and(scope, isNotNull(paymentDispute.closedAt)))
    .returning({ id: paymentDispute.id });
  if (lifted.length > 0) return DONE;
  const open = await db.select({ id: paymentDispute.id }).from(paymentDispute).where(scope);
  return refused(open.length > 0 ? "open_at_stripe" : "gone");
}

const ANSWER_PREFIX = { manual: MANUAL_PREFIX, forfeited: FORFEITED_PREFIX } as const;

/**
 * Answers a booked reversal with a `tutor_transfer` of its amount: unstamped to send it again, or stamped
 * `manual:` (paid another way) or `forfeited:` (written off). Under the transfer sweep's lock, so the answer and
 * the sweep's own reading of what is owed never interleave.
 */
export async function answerReversal(params: {
  operator: OperatorActor;
  reversalId: string;
  answer: ReversalAnswer;
}): Promise<AnswerResult> {
  const scope = and(
    eq(ledgerEntry.id, params.reversalId),
    eq(ledgerEntry.type, "transfer_reversal"),
    inArray(ledgerEntry.institutionId, params.operator.operatorInstitutionIds),
  );
  try {
    return await db.transaction(async (tx) => {
      const [reversal] = await tx
        .select({ engagementId: ledgerEntry.engagementId, institutionId: ledgerEntry.institutionId })
        .from(ledgerEntry)
        .where(scope);
      if (!reversal) return refused("gone");
      await tx
        .select({ id: engagement.id })
        .from(engagement)
        .where(and(eq(engagement.id, reversal.engagementId), eq(engagement.institutionId, reversal.institutionId)))
        .for("no key update");
      // A separate statement after the lock: one statement's snapshot predates its own lock wait.
      const [state] = await tx
        .select({
          amountMinor: ledgerEntry.amountMinor,
          currency: ledgerEntry.currency,
          answered: exists(answerTo(ledgerEntry.id)),
          paused: paused(ledgerEntry.engagementId, ledgerEntry.institutionId),
        })
        .from(ledgerEntry)
        .where(scope);
      if (state.answered) return refused("answered");
      if (params.answer === "resend" && state.paused) return refused("paused");

      const [row] = await tx
        .insert(ledgerEntry)
        .values({
          ...reversal,
          type: "tutor_transfer",
          amountMinor: state.amountMinor,
          currency: state.currency,
          correctsEntryId: params.reversalId,
          recordedByUserId: params.operator.userId,
          stripeReference: params.answer === "resend" ? null : `${ANSWER_PREFIX[params.answer]}${params.reversalId}`,
        })
        .returning({ id: ledgerEntry.id });
      return { ok: true, resend: params.answer === "resend" ? { ...reversal, id: row.id } : null };
    });
  } catch (error) {
    if (uniqueViolation(error, "ledger_entry_corrects_entry_idx")) return refused("answered");
    throw error;
  }
}
