import { and, desc, eq, exists, inArray, isNotNull, isNull, ne, not, notExists, or, sql, type AnyColumn } from "drizzle-orm";
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
import { blockedRefunds, refundHeldBy, stoppedForGood } from "./refunds";
import { blockedEngagements, paused } from "./transfers";

type DiscrepancyKind = (typeof moneyDiscrepancyKind.enumValues)[number];
type LedgerType = (typeof ledgerEntryType.enumValues)[number];

export type EngagementContext = { courseLabel: string; tutorName: string; studentName: string };

export type DiscrepancyItem = {
  id: string;
  kind: Exclude<DiscrepancyKind, "orphaned_account">;
  /** Null on a transfers gap, whose flag is keyed on the engagement id rather than a Stripe object. */
  stripeReference: string | null;
  refundReference: string | null;
  ledgerAmountMinor: number | null;
  stripeAmountMinor: number | null;
  currency: string;
  detectedAt: Date;
  ledgerEntryType: LedgerType | null;
  /** What settling marks paid by hand: the package refund a failed Dashboard refund holds, once it is written. */
  heldRefundMinor: number | null;
  engagement: EngagementContext | null;
  canSettle: boolean;
  canResolve: boolean;
  paymentBooked: boolean;
  /**
   * What the flag does to a refund: its own keeps retrying while it is open or failed at Stripe, or it holds the
   * package's refund row, which another flag naming it may also stop for good.
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

const heldRefund = <T>(column: Parameters<typeof refundHeldBy>[0]) =>
  sql<T | null>`case when ${moneyDiscrepancy.kind} = 'refund_failed' and ${moneyDiscrepancy.ledgerEntryId} is null
    then (${refundHeldBy(column, moneyDiscrepancy.stripeReference, moneyDiscrepancy.institutionId)}) end`;

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

const settleable = () =>
  sql<boolean>`(${moneyDiscrepancy.kind} = 'refund_failed' or (${namesUnstampedRow()} and not ${refundFailed()}))`;

/** Resolved, a row would stay unsent and unsettled for good: one the flag stopped, or a held one another flag stopped. */
const strandsRow = () => sql<boolean>`(${namesUnstampedRow()} or coalesce(${heldRefund<boolean>(stoppedForGood())}, false))`;

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
        stripeReference: sql<string | null>`nullif(${moneyDiscrepancy.stripeReference}, ${moneyDiscrepancy.engagementId}::text)`,
        refundReference: moneyDiscrepancy.refundReference,
        ledgerAmountMinor: moneyDiscrepancy.ledgerAmountMinor,
        stripeAmountMinor: moneyDiscrepancy.stripeAmountMinor,
        currency: moneyDiscrepancy.currency,
        detectedAt: moneyDiscrepancy.detectedAt,
        ledgerEntryType: ledgerEntry.type,
        heldRefundMinor: heldRefund<number>(ledgerEntry.amountMinor),
        canSettle: settleable(),
        canResolve: sql<boolean>`not ${strandsRow()}`,
        paymentBooked: sql<boolean>`${purchaseBooked()}`,
        refund: sql<DiscrepancyItem["refund"]>`case when ${retriesRefund()} then 'retrying'
          when ${refundFailed()} then 'failed'
          when ${heldRefund<boolean>(stoppedForGood())} then 'holding_stopped'
          when ${heldRefund<string>(ledgerEntry.id)} is not null then 'holding' end`,
      })
      .from(moneyDiscrepancy)
      .leftJoin(
        ledgerEntry,
        and(eq(ledgerEntry.id, moneyDiscrepancy.ledgerEntryId), eq(ledgerEntry.institutionId, moneyDiscrepancy.institutionId)),
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

  const context = await contexts(campuses, [
    ...new Set([...flags, ...disputes, ...reversals].flatMap((row) => (row.engagementId ? [row.engagementId] : []))),
  ]);
  const on = (engagementId: string) => context.get(engagementId) ?? null;
  const sum = (counts: number[]) => counts.reduce((total, n) => total + n, 0);

  return {
    discrepancies: flags.flatMap(({ engagementId, kind, ...flag }) =>
      kind === "orphaned_account" ? [] : [{ ...flag, kind, engagement: engagementId ? on(engagementId) : null }],
    ),
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
    .set({ resolvedAt: new Date(), resolutionNote: params.note, resolvedByUserId: params.operator.userId })
    .where(and(scope, not(strandsRow())))
    .returning({ id: moneyDiscrepancy.id });
  if (resolved.length > 0) return DONE;
  const open = await db.select({ id: moneyDiscrepancy.id }).from(moneyDiscrepancy).where(scope);
  return refused(open.length > 0 ? "settle_instead" : "gone");
}

/**
 * Ops paid the student or the tutor another way. The named refund or transfer row is stamped `manual:<discrepancy
 * id>` in the same transaction, so it stays the engagement's one row of its kind and no sweep sees it again. A failed
 * Dashboard refund's flag names no row, so it stamps the package refund it holds, if one is written yet. A flag
 * on a refund made in the Dashboard stamps the row with that `re_…` instead: it is the refund that happened, and the
 * reconciliation then counts it. Any gap between its amount and the row's is ops' to settle. One that then
 * failed at Stripe is never booked: the student is paid by hand on the payment's refund_failed flag.
 */
export async function recordManualSettlement(params: {
  operator: OperatorActor;
  discrepancyId: string;
  note: string;
}): Promise<SettleResult> {
  return db.transaction(async (tx) => {
    const scope = openOnCampus(params.operator, params.discrepancyId);
    const [found] = await tx
      .select({
        institutionId: moneyDiscrepancy.institutionId,
        ledgerEntryId: moneyDiscrepancy.ledgerEntryId,
        stripeReference: moneyDiscrepancy.stripeReference,
        settleable: settleable(),
        namesUnstampedRow: sql<boolean>`${namesUnstampedRow()}`,
        heldRefundId: heldRefund<string>(ledgerEntry.id),
      })
      .from(moneyDiscrepancy)
      .where(scope)
      .for("update");
    if (!found) return refused("gone");
    if (!found.settleable) return refused("not_settleable");

    const unstampedRowId = found.namesUnstampedRow ? found.ledgerEntryId : found.heldRefundId;
    if (unstampedRowId) {
      const stamped = await tx
        .update(ledgerEntry)
        .set({
          stripeReference: found.stripeReference?.startsWith("re_") ? found.stripeReference : `${MANUAL_PREFIX}${params.discrepancyId}`,
        })
        .where(
          and(
            eq(ledgerEntry.id, unstampedRowId),
            eq(ledgerEntry.institutionId, found.institutionId),
            inArray(ledgerEntry.type, ["refund", "tutor_transfer"]),
            isNull(ledgerEntry.stripeReference),
          ),
        )
        .returning({ id: ledgerEntry.id });
      // Stripe stamped the row since it was read: the money moved there, so settling by hand would pay twice.
      if (stamped.length === 0) return refused("not_settleable");
    }
    await tx
      .update(moneyDiscrepancy)
      .set({ resolvedAt: new Date(), resolutionNote: params.note, resolvedByUserId: params.operator.userId })
      .where(scope);
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
