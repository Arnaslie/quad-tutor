import { and, eq, exists, isNotNull, isNull, like, lt, not, notExists, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias, type SelectedFields } from "drizzle-orm/pg-core";
import { z } from "zod";

import { db } from "@/server/db";
import { engagement, ledgerEntry, moneyDiscrepancy, paymentDispute, tutorCourse, tutorProfile } from "@/server/db/schema";

import { refreshKyc } from "./connect";
import { ledgerRowBlocker, recordDiscrepancy, type Ids } from "./discrepancy";
import type { KycStatus } from "./kyc";
import { withLease } from "./lease";
import { createOnce } from "./refunds";
import { GatewayError, errorFacts, stripeGateway, type Transfer } from "./stripe";

const RETRY_GRACE_MS = 5 * 60 * 1000;
const RETRY_LIMIT = 20;
const DECIDE_LIMIT = 50;
const LEASE_MS = 5 * 60 * 1000;

export type TransferCounts = {
  sent: number;
  settled: number;
  waiting: number;
  flagged: number;
  blocked: number;
  failed: number;
};

type Outcome = "transferred" | "waiting" | "flagged" | "in_flight" | "failed";

type Payee = Ids & { paymentIntentId: string; accountId: string | null; kycStatus: KycStatus };

type Sending = Ids & {
  id: string;
  amountMinor: number;
  currency: string;
  occurredAt: Date;
  accountId: string;
  chargeId: string;
};

const purchase = alias(ledgerEntry, "purchase");
const owing = alias(ledgerEntry, "owing");

const boughtThroughStripe = (engagementId: AnyColumn, institutionId: AnyColumn) =>
  and(
    eq(purchase.engagementId, engagementId),
    eq(purchase.institutionId, institutionId),
    eq(purchase.type, "package_purchase"),
    like(purchase.stripeReference, "pi\\_%"),
  );

/** Accrued less every transfer row, stamped or not, so a row still in flight is never sent twice. */
const owedMinor = (engagementId: AnyColumn | string, institutionId: AnyColumn | string) =>
  sql<number>`(${db
    .select({
      owed: sql`coalesce(sum(case ${owing.type}
        when 'tutor_accrued' then ${owing.amountMinor}
        when 'tutor_transfer' then -${owing.amountMinor}
        else 0 end), 0)::int`,
    })
    .from(owing)
    .where(and(eq(owing.engagementId, engagementId), eq(owing.institutionId, institutionId)))})`;

const unstampedTransfer = (engagementId: AnyColumn, institutionId: AnyColumn, ...more: SQL[]) =>
  db
    .select({ id: owing.id })
    .from(owing)
    .where(
      and(
        eq(owing.engagementId, engagementId),
        eq(owing.institutionId, institutionId),
        eq(owing.type, "tutor_transfer"),
        isNull(owing.stripeReference),
        ...more,
      ),
    );

const paused = (engagementId: AnyColumn | string, institutionId: AnyColumn | string) => sql<boolean>`(${exists(
      db
        .select({ id: paymentDispute.id })
        .from(paymentDispute)
        .where(
          and(
            eq(paymentDispute.engagementId, engagementId),
            eq(paymentDispute.institutionId, institutionId),
            isNull(paymentDispute.resolvedAt),
          ),
        ),
  )} or ${exists(
      db
        .select({ id: moneyDiscrepancy.id })
        .from(moneyDiscrepancy)
        .where(
          and(
            eq(moneyDiscrepancy.engagementId, engagementId),
            eq(moneyDiscrepancy.institutionId, institutionId),
            isNull(moneyDiscrepancy.resolvedAt),
          ),
        ),
  )})`;

function payees<T extends SelectedFields>(fields: T) {
  return db
    .select({
      ...fields,
      engagementId: engagement.id,
      institutionId: engagement.institutionId,
      paymentIntentId: sql<string>`${purchase.stripeReference}`,
      accountId: tutorProfile.stripeAccountId,
      kycStatus: tutorProfile.kycStatus,
    })
    .from(engagement)
    .innerJoin(purchase, boughtThroughStripe(engagement.id, engagement.institutionId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(
      tutorProfile,
      and(eq(tutorProfile.id, tutorCourse.tutorProfileId), eq(tutorProfile.institutionId, engagement.institutionId)),
    );
}

/** Unstamped rows past the grace, so the sweep stays off a call still in flight. */
function unstampedRows(institutionId: string) {
  return payees({
    id: ledgerEntry.id,
    amountMinor: ledgerEntry.amountMinor,
    currency: ledgerEntry.currency,
    occurredAt: ledgerEntry.occurredAt,
    paused: paused(ledgerEntry.engagementId, ledgerEntry.institutionId),
  })
    .innerJoin(ledgerEntry, and(eq(ledgerEntry.engagementId, engagement.id), eq(ledgerEntry.institutionId, engagement.institutionId)))
    .where(
      and(
        eq(ledgerEntry.institutionId, institutionId),
        eq(ledgerEntry.type, "tutor_transfer"),
        isNull(ledgerEntry.stripeReference),
        lt(ledgerEntry.occurredAt, new Date(Date.now() - RETRY_GRACE_MS)),
        notExists(ledgerRowBlocker(ledgerEntry.id, ledgerEntry.institutionId)),
      ),
    )
    .orderBy(sql`random()`)
    .limit(RETRY_LIMIT);
}

/** The KYC status is only a prefilter; Stripe is asked again before any money moves. */
function owedEngagements(institutionId: string) {
  return payees({})
    .where(
      and(
        eq(engagement.institutionId, institutionId),
        isNotNull(tutorProfile.stripeAccountId),
        eq(tutorProfile.kycStatus, "verified"),
        sql`${owedMinor(engagement.id, engagement.institutionId)} > 0`,
        not(paused(engagement.id, engagement.institutionId)),
      ),
    )
    .orderBy(sql`random()`)
    .limit(DECIDE_LIMIT);
}

/** Money held for ops: a paused engagement still owing or mid-transfer, or a transfer row a discrepancy stopped. */
async function blockedEngagements(institutionId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(engagement)
    .innerJoin(purchase, boughtThroughStripe(engagement.id, engagement.institutionId))
    .where(
      and(
        eq(engagement.institutionId, institutionId),
        or(
          and(
            paused(engagement.id, engagement.institutionId),
            or(
              sql`${owedMinor(engagement.id, engagement.institutionId)} > 0`,
              exists(unstampedTransfer(engagement.id, engagement.institutionId)),
            ),
          ),
          exists(
            unstampedTransfer(engagement.id, engagement.institutionId, exists(ledgerRowBlocker(owing.id, owing.institutionId))),
          ),
        ),
      ),
    );
  return row?.n ?? 0;
}

async function stamp(row: Ids & { id: string }, reference: string): Promise<void> {
  await db
    .update(ledgerEntry)
    .set({ stripeReference: reference })
    .where(
      and(
        eq(ledgerEntry.id, row.id),
        eq(ledgerEntry.institutionId, row.institutionId),
        eq(ledgerEntry.type, "tutor_transfer"),
        isNull(ledgerEntry.stripeReference),
      ),
    );
}

const ours = async (row: Ids & { id: string }) =>
  (await stripeGateway().listTransfers(row.engagementId)).find((t) => t.ledgerEntryId === row.id);

type Kyc = (payee: Payee) => Promise<KycStatus | null>;

function kycThisRun(): Kyc {
  const seen = new Map<string, Promise<KycStatus | null>>();
  return (payee) => {
    if (!payee.accountId || payee.kycStatus !== "verified") return Promise.resolve(payee.kycStatus);
    const status = seen.get(payee.accountId) ?? refreshKyc(payee.accountId, payee.institutionId);
    seen.set(payee.accountId, status);
    return status;
  };
}

async function chargeOf(payee: Payee): Promise<string | null> {
  const chargeId = await stripeGateway().chargeOf(payee.paymentIntentId);
  if (!chargeId) console.error(`[transfer] ${payee.paymentIntentId} has no charge; ${payee.engagementId} skipped`);
  return chargeId;
}

async function send(row: Sending, retry: boolean): Promise<Outcome> {
  const gateway = stripeGateway();
  let transfer: Transfer;
  try {
    transfer = await createOnce(
      (idempotencyKey) =>
        gateway.createTransfer({
          accountId: row.accountId,
          chargeId: row.chargeId,
          amountMinor: row.amountMinor,
          currency: row.currency,
          engagementId: row.engagementId,
          institutionId: row.institutionId,
          ledgerEntryId: row.id,
          idempotencyKey,
        }),
      `transfer:${row.id}`,
      retry ? row.occurredAt : null,
      () => ours(row),
      // Only an unverified account's refusal leaves a row unflagged, and the account was verified since.
      (error) => (error.status ?? 0) >= 500 || error.refused,
    );
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (error.inFlight) return "in_flight";
    if (!error.refused) throw error;
    if ((await refreshKyc(row.accountId, row.institutionId)) !== "verified") return "waiting";
    console.error(`[transfer] ${row.id} refused for a verified account ${errorFacts(error)}; flagged for ops`);
    await recordDiscrepancy(row, {
      kind: "ledger_vs_stripe_transfers",
      ledgerEntryId: row.id,
      ledgerAmountMinor: row.amountMinor,
      currency: row.currency,
    });
    return "flagged";
  }
  await stamp(row, transfer.id);
  return "transferred";
}

/** A paused engagement's row is still stamped when Stripe has its transfer; only a new create waits on ops. */
async function retry(row: Awaited<ReturnType<typeof unstampedRows>>[number], kyc: Kyc): Promise<Outcome | null> {
  const found = await ours(row);
  if (found) {
    await stamp(row, found.id);
    return "transferred";
  }
  if (row.paused) return null;
  if (!row.accountId || (await kyc(row)) !== "verified") return "waiting";
  const chargeId = await chargeOf(row);
  if (!chargeId) return "failed";
  return send({ ...row, accountId: row.accountId, chargeId }, true);
}

async function decide(payee: Payee, kyc: Kyc): Promise<Outcome | null> {
  if (!payee.accountId || (await kyc(payee)) !== "verified") return "waiting";
  const chargeId = await chargeOf(payee);
  if (!chargeId) return "failed";

  const row = await db.transaction(async (tx) => {
    const scope = and(eq(engagement.id, payee.engagementId), eq(engagement.institutionId, payee.institutionId));
    const [locked] = await tx.select({ currency: engagement.currency }).from(engagement).where(scope).for("no key update");
    if (!locked) return null;
    // A separate statement after the lock: one statement's snapshot predates its own lock wait.
    const [due] = await tx
      .select({
        owedMinor: owedMinor(payee.engagementId, payee.institutionId),
        paused: paused(payee.engagementId, payee.institutionId),
      })
      .from(engagement)
      .where(scope);
    if (!due || due.owedMinor <= 0 || due.paused) return null;
    const [inserted] = await tx
      .insert(ledgerEntry)
      .values({
        engagementId: payee.engagementId,
        institutionId: payee.institutionId,
        type: "tutor_transfer",
        amountMinor: due.owedMinor,
        currency: locked.currency,
      })
      .returning({
        id: ledgerEntry.id,
        amountMinor: ledgerEntry.amountMinor,
        currency: ledgerEntry.currency,
        occurredAt: ledgerEntry.occurredAt,
      });
    return inserted;
  });
  if (!row) return null;
  return send({ ...payee, ...row, accountId: payee.accountId, chargeId }, false);
}

async function attempt(subject: string, work: () => Promise<Outcome | null>): Promise<Outcome | null> {
  try {
    return await work();
  } catch (error) {
    console.error(`[transfer] ${subject} failed`, errorFacts(error));
    return "failed";
  }
}

async function sweepCampus(institutionId: string, deadline: number): Promise<Omit<TransferCounts, "blocked">> {
  const counts = { sent: 0, settled: 0, waiting: 0, flagged: 0, failed: 0 };
  const tally = (outcome: Outcome | null, transferred: "sent" | "settled") => {
    if (outcome === "transferred") counts[transferred] += 1;
    else if (outcome === "waiting" || outcome === "flagged" || outcome === "failed") counts[outcome] += 1;
  };
  const kyc = kycThisRun();
  let done = 0;
  const due = () => done++ > 0 && Date.now() > deadline;

  for (const row of await unstampedRows(institutionId)) {
    if (due()) return counts;
    tally(await attempt(row.id, () => retry(row, kyc)), "settled");
  }
  for (const payee of await owedEngagements(institutionId)) {
    if (due()) return counts;
    tally(await attempt(payee.engagementId, () => decide(payee, kyc)), "sent");
  }
  return counts;
}

/**
 * Sends each verified tutor what their engagements owe, never for one bought before Stripe. `sent` are
 * new transfers, `settled` rows an earlier run left unstamped, `waiting` tutors Stripe has not verified.
 */
export async function runTransfers(institutionId: string, deadline: number): Promise<TransferCounts> {
  const counts = await withLease(institutionId, "tutor-transfers", LEASE_MS, () => sweepCampus(institutionId, deadline));
  return {
    ...(counts ?? { sent: 0, settled: 0, waiting: 0, flagged: 0, failed: 0 }),
    blocked: await blockedEngagements(institutionId),
  };
}

export const TRANSFER_EVENTS = new Set(["transfer.created", "transfer.reversed"]);

export type TransferEventOutcome = "transfer_synced" | "flagged" | "foreign";

const transferIds = z.object({ ledgerEntryId: z.uuid(), engagementId: z.uuid(), institutionId: z.uuid() });

/** Re-reads the transfer, so a repeated or out-of-order event only ever re-applies its current state. */
export async function handleTransferEvent(
  transferId: string,
): Promise<{ outcome: TransferEventOutcome; institutionId: string | null }> {
  const transfer = await stripeGateway().retrieveTransfer(transferId);
  const parsed = transferIds.safeParse(transfer);
  if (!parsed.success) return { outcome: "foreign", institutionId: null };
  const { ledgerEntryId, ...ids } = parsed.data;

  const [row] = await db
    .select({ id: ledgerEntry.id, amountMinor: ledgerEntry.amountMinor, currency: ledgerEntry.currency, reference: ledgerEntry.stripeReference })
    .from(ledgerEntry)
    .where(
      and(
        eq(ledgerEntry.id, ledgerEntryId),
        eq(ledgerEntry.engagementId, ids.engagementId),
        eq(ledgerEntry.institutionId, ids.institutionId),
        eq(ledgerEntry.type, "tutor_transfer"),
      ),
    );
  if (!row) return { outcome: "foreign", institutionId: null };

  const otherTransfer = row.reference !== null && row.reference !== transfer.id;
  if (otherTransfer || row.amountMinor !== transfer.amountMinor || row.currency !== transfer.currency) {
    console.error(`[transfer] ${transfer.id} does not match ledger row ${row.id}; flagged for ops`);
    await recordDiscrepancy(ids, {
      kind: "ledger_vs_stripe_transfers",
      stripeReference: transfer.id,
      ledgerEntryId: row.id,
      ledgerAmountMinor: row.amountMinor,
      stripeAmountMinor: transfer.amountMinor,
      currency: row.currency,
    });
    // A second transfer on a row already stamped is not one the ledger knows; its reversals are ops' to book.
    if (otherTransfer) return { outcome: "flagged", institutionId: ids.institutionId };
  }
  await stamp({ ...ids, id: row.id }, transfer.id);
  if (transfer.reversals.length > 0) {
    await db
      .insert(ledgerEntry)
      .values(
        transfer.reversals.map((reversal) => ({
          ...ids,
          type: "transfer_reversal" as const,
          amountMinor: reversal.amountMinor,
          currency: transfer.currency,
          stripeReference: reversal.id,
        })),
      )
      .onConflictDoNothing();
  }
  return { outcome: "transfer_synced", institutionId: ids.institutionId };
}
