import { and, eq } from "drizzle-orm";

import { db } from "@/server/db";
import { reliabilityEvent, sessionBooking } from "@/server/db/schema";
import { record } from "@/server/modules/billing/ledger";
import { perSessionMinor } from "@/server/modules/billing/pricing";

import { SessionError, type Participation } from "./access";
import { isLateCancel } from "./attendance";
import { cancelRefundsCard, cancelSplit, hoursBefore } from "./cancel-rules";
import { recognise } from "./confirmation";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CancelCharge = {
  late: boolean;
  keptMinor: number;
  returnedMinor: number;
  /** The session no longer goes back in the package. */
  used: boolean;
  refundId: string | null;
};

/** The session crossed a cancel line between the quote the student saw and the submit. Nothing was cancelled. */
export class CancelQuoteChanged extends SessionError {
  constructor(readonly quote: { keptMinor: number; returnedMinor: number; toCard: boolean; late: boolean }) {
    super("The amount changed since you opened this. Nothing was cancelled. Check the new amount and cancel again.");
  }
}

/**
 * Cancels a scheduled session the caller has locked, with the engagement locked before it. `shownKeptMinor` is
 * the kept share the student was shown; a different one on the server's clock refuses before anything is written.
 */
export async function chargeCancel(
  tx: Tx,
  session: Participation,
  cancelledByUserId: string,
  now: Date,
  shownKeptMinor?: number,
): Promise<CancelCharge> {
  const late = isLateCancel(session.scheduledAt, now);
  const hours = hoursBefore(session.scheduledAt, now);
  const { keptMinor, returnedMinor } = cancelSplit(perSessionMinor(session), hours, session.role);
  const toCard = cancelRefundsCard(session.sessionsPurchased, hours, session.role);
  if (shownKeptMinor !== undefined && shownKeptMinor !== keptMinor) {
    throw new CancelQuoteChanged({ keptMinor, returnedMinor, toCard, late });
  }

  await tx
    .update(sessionBooking)
    .set({ status: "cancelled", cancelledAt: now, cancelledByUserId })
    .where(and(eq(sessionBooking.id, session.sessionId), eq(sessionBooking.status, "scheduled")));

  if (keptMinor > 0) await recognise(tx, session, keptMinor);

  // Naming the session marks it used, so it never goes back in the package.
  const [refund] =
    toCard && returnedMinor > 0
      ? await record(tx, [
          {
            engagementId: session.engagementId,
            institutionId: session.institutionId,
            sessionId: session.sessionId,
            type: "refund",
            amountMinor: returnedMinor,
            currency: session.currency,
          },
        ])
      : [];

  if (late && session.role === "student") {
    await tx.insert(reliabilityEvent).values({
      userId: session.studentUserId,
      institutionId: session.institutionId,
      sessionId: session.sessionId,
      type: "late_cancelled",
      occurredAt: now,
    });
  }

  return { late, keptMinor, returnedMinor, used: keptMinor > 0 || toCard, refundId: refund?.id ?? null };
}
