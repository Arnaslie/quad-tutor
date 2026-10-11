import { and, eq, isNull, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { moneyDiscrepancy } from "@/server/db/schema";

import type { Refund } from "./stripe";

type Ids = { engagementId: string; institutionId: string };

export async function recordDiscrepancy(
  ids: Ids,
  values: Omit<typeof moneyDiscrepancy.$inferInsert, "institutionId" | "engagementId">,
): Promise<string | null> {
  const [created] = await db
    .insert(moneyDiscrepancy)
    .values({ ...values, institutionId: ids.institutionId, engagementId: ids.engagementId })
    .onConflictDoNothing()
    .returning({ id: moneyDiscrepancy.id });
  if (created || !values.stripeReference) return created?.id ?? null;

  const [existing] = await db
    .select({ id: moneyDiscrepancy.id })
    .from(moneyDiscrepancy)
    .where(
      and(
        eq(moneyDiscrepancy.institutionId, ids.institutionId),
        eq(moneyDiscrepancy.kind, values.kind),
        eq(moneyDiscrepancy.stripeReference, values.stripeReference),
      ),
    );
  return existing?.id ?? null;
}

/**
 * A refund Stripe could not deliver is never re-issued by code: the card that bounced it would bounce
 * the next one too. Ops pays the student another way and appends the corrective row.
 */
export async function recordRefundFailure(
  ids: Ids,
  failed: { refund: Refund | null; paymentIntentId: string; amountMinor: number | null; currency: string },
): Promise<void> {
  const reference = failed.refund?.id ?? failed.paymentIntentId;
  console.error(
    `[refund] ${reference} for ${ids.engagementId} failed (${failed.refund?.failureReason ?? "refused at create"}); flagged for ops`,
  );
  await recordDiscrepancy(ids, {
    kind: "refund_failed",
    stripeReference: reference,
    ledgerAmountMinor: failed.amountMinor,
    stripeAmountMinor: 0,
    currency: failed.currency,
  });
}

const failure = alias(moneyDiscrepancy, "refund_failure");

/** Open refund failures stop every automatic refund for the engagement until ops resolves them. */
export const openRefundFailure = (engagementId: AnyColumn) =>
  db
    .select({ id: failure.id })
    .from(failure)
    .where(and(eq(failure.engagementId, engagementId), eq(failure.kind, "refund_failed"), isNull(failure.resolvedAt)));
