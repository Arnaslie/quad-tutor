import { and, eq, like, or, type AnyColumn } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/server/db";
import { moneyDiscrepancy } from "@/server/db/schema";

import type { Refund } from "./stripe";

export type Ids = { engagementId: string; institutionId: string };

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

const blocker = alias(moneyDiscrepancy, "refund_blocker");

/**
 * A failed refund, or one Stripe holds that is not ours, stops every automatic refund for the engagement
 * for good. Resolving it never re-arms one: ops settles the student by hand (`recordManualRefund`).
 */
export const refundBlocker = (engagementId: AnyColumn | string, institutionId: AnyColumn | string) =>
  db
    .select({ id: blocker.id })
    .from(blocker)
    .where(
      and(
        eq(blocker.engagementId, engagementId),
        eq(blocker.institutionId, institutionId),
        or(eq(blocker.kind, "refund_failed"), like(blocker.stripeReference, "re\\_%")),
      ),
    );

export async function refundBlocked(ids: Ids): Promise<boolean> {
  return (await refundBlocker(ids.engagementId, ids.institutionId).limit(1)).length > 0;
}
