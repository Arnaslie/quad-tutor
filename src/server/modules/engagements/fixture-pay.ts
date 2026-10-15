import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, ledgerEntry, studentProfile, tutorCourse, tutorProfile } from "@/server/db/schema";
import type { Ids } from "@/server/modules/billing/discrepancy";
import { FIXTURE_PAYMENT_PREFIX, FIXTURE_TRANSFER_PREFIX, isPersona } from "@/server/modules/billing/fixtures";
import { reserveTransfer } from "@/server/modules/billing/transfers";

import { fulfilCheckout } from "./checkout";
import type { PurchaseResult } from "./purchase";

async function personasOnly(ids: Ids): Promise<{ purchaseReference: string | null }> {
  const [row] = await db
    .select({
      studentUserId: studentProfile.userId,
      tutorUserId: tutorProfile.userId,
      purchaseReference: ledgerEntry.stripeReference,
    })
    .from(engagement)
    .innerJoin(studentProfile, eq(studentProfile.id, engagement.studentProfileId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .innerJoin(tutorProfile, eq(tutorProfile.id, tutorCourse.tutorProfileId))
    .leftJoin(
      ledgerEntry,
      and(
        eq(ledgerEntry.engagementId, engagement.id),
        eq(ledgerEntry.institutionId, engagement.institutionId),
        eq(ledgerEntry.type, "package_purchase"),
      ),
    )
    .where(and(eq(engagement.id, ids.engagementId), eq(engagement.institutionId, ids.institutionId)));
  if (!row) throw new Error(`Engagement ${ids.engagementId} not found.`);
  if (!isPersona(row.studentUserId) || !isPersona(row.tutorUserId)) {
    throw new Error(`Fixture money is refused on ${ids.engagementId}: both sides must be personas.`);
  }
  return row;
}

export async function fixturePay(result: PurchaseResult): Promise<{ engagementId: string }> {
  if (result.outcome !== "checkout") throw new Error(`Checkout ${result.engagementId}: ${result.outcome}`);
  const { engagementId, checkout } = result;
  await personasOnly(checkout);

  const id = randomUUID();
  const fulfilled = await fulfilCheckout({
    engagementId,
    institutionId: checkout.institutionId,
    checkoutSessionId: `fixture_cs_${id}`,
    payment: {
      paymentIntentId: `${FIXTURE_PAYMENT_PREFIX}${id}`,
      amountTotal: checkout.amountMinor,
      currency: checkout.currency,
    },
  });
  if (fulfilled.outcome !== "fulfilled") {
    throw new Error(`Checkout ${engagementId} did not fulfil: ${fulfilled.outcome}`);
  }
  return { engagementId };
}

export async function fixturePayout(ids: Ids): Promise<{ transferredMinor: number }> {
  const { purchaseReference } = await personasOnly(ids);
  if (!purchaseReference?.startsWith(FIXTURE_PAYMENT_PREFIX)) {
    throw new Error(`Engagement ${ids.engagementId} was not bought with fixture money.`);
  }
  const row = await reserveTransfer(ids, `${FIXTURE_TRANSFER_PREFIX}${randomUUID()}`);
  return { transferredMinor: row?.amountMinor ?? 0 };
}
