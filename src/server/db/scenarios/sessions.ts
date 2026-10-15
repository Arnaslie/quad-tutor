import { and, eq } from "drizzle-orm";

import { db } from "../index";
import { ledgerEntry, sessionBooking } from "../schema";

import type { Actor } from "@/server/modules/identity/actor";
import { bookSession, slotsForEngagement } from "@/server/modules/engagements/scheduling";
import { confirmationDeadline } from "@/server/modules/engagements/slots";

export async function bookSessions(params: {
  student: Actor;
  engagementId: string;
  count: number;
  studentNote: string;
}): Promise<void> {
  for (let i = 0; i < params.count; i += 1) {
    const open = await slotsForEngagement({
      actor: params.student,
      engagementId: params.engagementId,
    });
    await bookSession({
      actor: params.student,
      engagementId: params.engagementId,
      slotStartsAt: open[0],
      studentNote: params.studentNote,
    });
  }
}

export async function sessionIdsInOrder(engagementId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessionBooking.id })
    .from(sessionBooking)
    .where(eq(sessionBooking.engagementId, engagementId))
    .orderBy(sessionBooking.scheduledAt);
  return rows.map((row) => row.id);
}

export async function moveIntoPast(params: {
  engagementId: string;
  sessionId: string;
  hoursAgo: number;
}): Promise<void> {
  const scheduledAt = new Date(Date.now() - params.hoursAgo * 60 * 60 * 1000);

  await db
    .update(sessionBooking)
    .set({
      scheduledAt,
      confirmationWindowEndsAt: confirmationDeadline(scheduledAt),
    })
    .where(
      and(
        eq(sessionBooking.id, params.sessionId),
        eq(sessionBooking.engagementId, params.engagementId),
      ),
    );
}

/** Dates a recognised session's ledger rows to when it was taught, so its rating window closed as an old one's would. */
export async function backdateLedger(params: {
  engagementId: string;
  sessionId: string;
  at: Date;
}): Promise<void> {
  await db
    .update(ledgerEntry)
    .set({ occurredAt: params.at })
    .where(
      and(
        eq(ledgerEntry.sessionId, params.sessionId),
        eq(ledgerEntry.engagementId, params.engagementId),
      ),
    );
}
