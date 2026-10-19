import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { escapeLike } from "@/server/db/like";
import {
  engagement,
  engagementStatus,
  ledgerEntry,
  ledgerEntryType,
  studentProfile,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";

import { FEE_MILESTONE_MINOR, LOWER_TAKE_RATE_BP, TAKE_RATE_BP } from "./pricing";
import { FORFEITED_PREFIX, MANUAL_PREFIX } from "./discrepancy";
import { FIXTURE_PAYMENT_PREFIX, FIXTURE_TRANSFER_PREFIX, PERSONA_PREFIX, isFixture } from "./fixtures";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LedgerType = (typeof ledgerEntryType.enumValues)[number];
type EngagementStatus = (typeof engagementStatus.enumValues)[number];

const PURCHASE = "package_purchase" satisfies LedgerType;
const EARNED = "session_earned" satisfies LedgerType;
const ACCRUED = "tutor_accrued" satisfies LedgerType;
const FEE = "platform_fee" satisfies LedgerType;
const REFUND = "refund" satisfies LedgerType;
const TRANSFER = "tutor_transfer" satisfies LedgerType;
const REVERSAL = "transfer_reversal" satisfies LedgerType;
const REFERENCED: LedgerType[] = [PURCHASE, REFUND, TRANSFER, REVERSAL];

const UNPAID: readonly EngagementStatus[] = ["pending_payment", "cancelled"];
const CLOSED: readonly EngagementStatus[] = ["completed", "refunded", "cancelled"];

type Totals = Partial<Record<LedgerType, { minor: number; rows: number }>>;

export type MoneyFacts = {
  engagements: {
    id: string;
    status: EngagementStatus;
    pricePaidMinor: number;
    betweenPersonas?: boolean;
    totals: Totals;
    references?: Partial<Record<LedgerType, (string | null)[]>>;
  }[];
  sessions: { id: string; tutorProfileId: string; totals: Totals }[];
};

export type MoneyViolation = { invariant: string; subject: string; detail: string };

const minor = (totals: Totals, type: LedgerType) => totals[type]?.minor ?? 0;
const rows = (totals: Totals, type: LedgerType) => totals[type]?.rows ?? 0;

export function moneyViolations(facts: MoneyFacts): MoneyViolation[] {
  const found: MoneyViolation[] = [];
  const flag = (invariant: string, subject: string, detail: string) =>
    found.push({ invariant, subject, detail });

  for (const e of facts.engagements) {
    const subject = `engagement ${e.id}`;
    const purchases = rows(e.totals, PURCHASE);
    const paid = minor(e.totals, PURCHASE);
    const refunded = minor(e.totals, REFUND);
    const deferred = paid - minor(e.totals, EARNED) - refunded;

    if (UNPAID.includes(e.status)) {
      if (purchases !== 0) flag("no purchase while unpaid", subject, `${e.status} with ${purchases} purchase rows`);
    } else if (purchases !== 1 || paid !== e.pricePaidMinor) {
      flag("one purchase of the price", subject, `${purchases} purchase rows totalling ${paid}, price ${e.pricePaidMinor}`);
    }
    if (refunded > paid) flag("refund <= purchase", subject, `refunded ${refunded} of ${paid}`);
    const references = (type: LedgerType) => e.references?.[type] ?? [];
    for (const reference of references(REFUND)) {
      if (reference && !reference.startsWith("re_") && !reference.startsWith(MANUAL_PREFIX)) {
        flag("refund reference is re_ or manual:", subject, reference);
      }
    }
    const fixturePurchase = references(PURCHASE).some((reference) => reference?.startsWith(FIXTURE_PAYMENT_PREFIX));
    if (!e.betweenPersonas) {
      for (const reference of REFERENCED.flatMap(references)) {
        if (isFixture(reference)) flag("fixture reference only between personas", subject, String(reference));
      }
    }
    for (const reference of references(TRANSFER)) {
      if (fixturePurchase) {
        if (!reference?.startsWith(FIXTURE_TRANSFER_PREFIX)) flag("a fixture purchase pays out fixture_tr_", subject, String(reference));
      } else if (reference && !["tr_", MANUAL_PREFIX, FORFEITED_PREFIX].some((prefix) => reference.startsWith(prefix))) {
        flag("transfer reference is tr_, manual: or forfeited:", subject, reference);
      }
    }
    for (const reference of references(REVERSAL)) {
      if (!reference?.startsWith("trr_")) flag("reversal reference is trr_", subject, String(reference));
    }
    if (rows(e.totals, TRANSFER) > 0 && !fixturePurchase && !references(PURCHASE).some((reference) => reference?.startsWith("pi_"))) {
      flag("transfers only from a Stripe purchase", subject, `${rows(e.totals, TRANSFER)} transfer rows`);
    }
    if (deferred < 0) flag("deferred >= 0", subject, `deferred ${deferred}`);
    if (CLOSED.includes(e.status) && deferred !== 0) {
      flag("deferred = 0 once closed", subject, `${e.status}, deferred ${deferred}`);
    }

    const transferred = minor(e.totals, TRANSFER) - minor(e.totals, REVERSAL);
    const accrued = minor(e.totals, ACCRUED);
    if (transferred > accrued) flag("transferred <= accrued", subject, `transferred ${transferred}, accrued ${accrued}`);
    if (transferred < 0) {
      flag("reversals <= transfers", subject, `reversed ${minor(e.totals, REVERSAL)} of ${minor(e.totals, TRANSFER)}`);
    }
  }

  const fullTakeFees = new Map<string, number[]>();
  for (const s of facts.sessions) {
    const subject = `session ${s.id}`;
    const earned = minor(s.totals, EARNED);
    const fee = minor(s.totals, FEE);
    const split = minor(s.totals, ACCRUED) + fee;
    const maxFee = Math.floor((earned * TAKE_RATE_BP) / 10_000);
    if (rows(s.totals, EARNED) > 1) flag("one recognition per session", subject, `${rows(s.totals, EARNED)} earned rows`);
    if (earned !== split) flag("earned = accrued + fee", subject, `earned ${earned}, split ${split}`);
    if (fee > maxFee) flag("fee <= take rate", subject, `fee ${fee}, max ${maxFee}`);
    if (fee > Math.floor((earned * LOWER_TAKE_RATE_BP) / 10_000)) {
      const fees = fullTakeFees.get(s.tutorProfileId) ?? [];
      fees.push(fee);
      fullTakeFees.set(s.tutorProfileId, fees);
    }
  }
  // The meter only grows, so the last session above 5% saw at least the sum of the others.
  for (const [tutorProfileId, fees] of fullTakeFees) {
    const beforeLast = fees.reduce((sum, fee) => sum + fee, 0) - Math.max(...fees);
    if (beforeLast >= FEE_MILESTONE_MINOR) {
      flag("full take only below the fee milestone", `tutor ${tutorProfileId}`, `${fees.length} sessions above 5%, ${beforeLast} charged before the last`);
    }
  }

  return found;
}

function collect(
  grouped: { key: string | null; type: LedgerType; minor: number; rows: number }[],
): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const row of grouped) {
    if (!row.key) continue;
    const totals = out.get(row.key) ?? {};
    totals[row.type] = { minor: row.minor, rows: row.rows };
    out.set(row.key, totals);
  }
  return out;
}

export async function moneyFacts(institutionId: string): Promise<MoneyFacts> {
  return db.transaction((tx) => readFacts(tx, institutionId), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function readFacts(tx: Tx, institutionId: string): Promise<MoneyFacts> {
  const total = sql<number>`coalesce(sum(${ledgerEntry.amountMinor}), 0)::bigint`.mapWith(Number);
  const count = sql<number>`count(${ledgerEntry.id})::int`;
  const persona = `${escapeLike(PERSONA_PREFIX)}%`;

  const [engagements, byEngagement, bySession, referenceRows] = await Promise.all([
    tx
      .select({
        id: engagement.id,
        status: engagement.status,
        pricePaidMinor: engagement.pricePaidMinor,
        betweenPersonas: sql<boolean>`${studentProfile.userId} like ${persona} and ${tutorProfile.userId} like ${persona}`,
      })
      .from(engagement)
      .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
      .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
      .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
      .where(eq(engagement.institutionId, institutionId)),
    tx
      .select({ key: ledgerEntry.engagementId, type: ledgerEntry.type, minor: total, rows: count })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.institutionId, institutionId))
      .groupBy(ledgerEntry.engagementId, ledgerEntry.type),
    tx
      .select({
        key: ledgerEntry.sessionId,
        tutorProfileId: tutorCourse.tutorProfileId,
        type: ledgerEntry.type,
        minor: total,
        rows: count,
      })
      .from(ledgerEntry)
      .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
      .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
      .where(and(eq(ledgerEntry.institutionId, institutionId), isNotNull(ledgerEntry.sessionId)))
      .groupBy(ledgerEntry.sessionId, tutorCourse.tutorProfileId, ledgerEntry.type),
    tx
      .select({ engagementId: ledgerEntry.engagementId, type: ledgerEntry.type, reference: ledgerEntry.stripeReference })
      .from(ledgerEntry)
      .where(
        and(
          eq(ledgerEntry.institutionId, institutionId),
          inArray(ledgerEntry.type, REFERENCED),
        ),
      ),
  ]);

  const ledger = collect(byEngagement);
  const sessionTotals = collect(bySession);
  const tutorOf = new Map<string, string>();
  for (const row of bySession) if (row.key) tutorOf.set(row.key, row.tutorProfileId);
  const references = new Map<string, Partial<Record<LedgerType, (string | null)[]>>>();
  for (const row of referenceRows) {
    const byType = references.get(row.engagementId) ?? {};
    byType[row.type] = [...(byType[row.type] ?? []), row.reference];
    references.set(row.engagementId, byType);
  }
  return {
    engagements: engagements.map((e) => ({
      ...e,
      totals: ledger.get(e.id) ?? {},
      references: references.get(e.id) ?? {},
    })),
    sessions: [...tutorOf].map(([id, tutorProfileId]) => ({ id, tutorProfileId, totals: sessionTotals.get(id) ?? {} })),
  };
}

export async function checkMoneyInvariants(institutionId: string): Promise<MoneyViolation[]> {
  return moneyViolations(await moneyFacts(institutionId));
}

export async function assertMoneyInvariants(institutionId: string): Promise<void> {
  const found = await checkMoneyInvariants(institutionId);
  if (found.length === 0) return;
  throw new Error(
    `money invariants broken on institution ${institutionId}:\n` +
      found.map((v) => `  ${v.invariant}: ${v.subject} (${v.detail})`).join("\n"),
  );
}
