import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "@/server/db";
import {
  courseOffering,
  engagement,
  engagementStatus,
  ledgerEntry,
  ledgerEntryType,
  tutorCourse,
} from "@/server/db/schema";

import { TAKE_RATE_BP, TERM_FEE_CAP_MINOR } from "./pricing";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LedgerType = (typeof ledgerEntryType.enumValues)[number];
type EngagementStatus = (typeof engagementStatus.enumValues)[number];

const PURCHASE = "package_purchase" satisfies LedgerType;
const EARNED = "session_earned" satisfies LedgerType;
const ACCRUED = "tutor_payout" satisfies LedgerType;
const FEE = "platform_fee" satisfies LedgerType;
const REFUND = "refund" satisfies LedgerType;
const TRANSFER = "tutor_transfer";
const REVERSAL = "transfer_reversal";

const UNPAID: readonly EngagementStatus[] = [];
const CLOSED: readonly EngagementStatus[] = ["completed", "refunded"];

type Totals = Record<string, { minor: number; rows: number }>;

export type MoneyFacts = {
  engagements: {
    id: string;
    status: EngagementStatus;
    pricePaidMinor: number;
    totals: Totals;
  }[];
  sessions: { id: string; totals: Totals }[];
  tutorTerms: { tutorProfileId: string; termId: string; feeMinor: number }[];
};

export type MoneyViolation = { invariant: string; subject: string; detail: string };

const minor = (totals: Totals, type: string) => totals[type]?.minor ?? 0;
const rows = (totals: Totals, type: string) => totals[type]?.rows ?? 0;

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
    if (deferred < 0) flag("deferred >= 0", subject, `deferred ${deferred}`);
    if (CLOSED.includes(e.status) && deferred !== 0) {
      flag("deferred = 0 once closed", subject, `${e.status}, deferred ${deferred}`);
    }

    const transferred = minor(e.totals, TRANSFER) - minor(e.totals, REVERSAL);
    const accrued = minor(e.totals, ACCRUED);
    if (transferred > accrued) flag("transferred <= accrued", subject, `transferred ${transferred}, accrued ${accrued}`);
  }

  for (const s of facts.sessions) {
    const subject = `session ${s.id}`;
    const earned = minor(s.totals, EARNED);
    const fee = minor(s.totals, FEE);
    const split = minor(s.totals, ACCRUED) + fee;
    const maxFee = Math.floor((earned * TAKE_RATE_BP) / 10_000);
    if (rows(s.totals, EARNED) > 1) flag("one recognition per session", subject, `${rows(s.totals, EARNED)} earned rows`);
    if (earned !== split) flag("earned = accrued + fee", subject, `earned ${earned}, split ${split}`);
    if (fee > maxFee) flag("fee <= take rate", subject, `fee ${fee}, max ${maxFee}`);
  }

  for (const t of facts.tutorTerms) {
    if (t.feeMinor > TERM_FEE_CAP_MINOR) {
      flag("fee <= term cap", `tutor ${t.tutorProfileId} term ${t.termId}`, `fee ${t.feeMinor}`);
    }
  }

  return found;
}

function collect(
  grouped: { key: string | null; type: string; minor: number; rows: number }[],
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
  const type = sql<string>`${ledgerEntry.type}::text`;
  const total = sql<number>`coalesce(sum(${ledgerEntry.amountMinor}), 0)::int`;
  const count = sql<number>`count(${ledgerEntry.id})::int`;

  const [engagements, byEngagement, bySession, tutorTerms] = await Promise.all([
    tx
      .select({ id: engagement.id, status: engagement.status, pricePaidMinor: engagement.pricePaidMinor })
      .from(engagement)
      .where(eq(engagement.institutionId, institutionId)),
    tx
      .select({ key: ledgerEntry.engagementId, type, minor: total, rows: count })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.institutionId, institutionId))
      .groupBy(ledgerEntry.engagementId, type),
    tx
      .select({ key: ledgerEntry.sessionId, type, minor: total, rows: count })
      .from(ledgerEntry)
      .where(and(eq(ledgerEntry.institutionId, institutionId), isNotNull(ledgerEntry.sessionId)))
      .groupBy(ledgerEntry.sessionId, type),
    tx
      .select({ tutorProfileId: tutorCourse.tutorProfileId, termId: courseOffering.termId, feeMinor: total })
      .from(ledgerEntry)
      .innerJoin(engagement, eq(engagement.id, ledgerEntry.engagementId))
      .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
      .innerJoin(courseOffering, eq(courseOffering.id, engagement.courseOfferingId))
      .where(and(eq(ledgerEntry.institutionId, institutionId), eq(ledgerEntry.type, FEE)))
      .groupBy(tutorCourse.tutorProfileId, courseOffering.termId),
  ]);

  const ledger = collect(byEngagement);
  return {
    engagements: engagements.map((e) => ({ ...e, totals: ledger.get(e.id) ?? {} })),
    sessions: [...collect(bySession)].map(([id, totals]) => ({ id, totals })),
    tutorTerms,
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
