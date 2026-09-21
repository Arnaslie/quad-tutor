import { and, eq, lte, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { engagement, reliabilityEvent, sessionBooking } from "@/server/db/schema";
import type { Actor } from "@/server/modules/identity/actor";
import { record } from "@/server/modules/billing/ledger";
import { perSessionMinor, splitMinor } from "@/server/modules/billing/pricing";

import {
  SessionError,
  lockSession,
  loadParticipation,
  sessionContext,
  type SessionContextRow,
} from "./access";
import { sessionEndsAt, settle, type Settlement } from "./attendance";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** TODO(stripe): the transfer against this accrual belongs in a payout run. */
async function recognise(
  tx: Tx,
  session: Pick<
    SessionContextRow,
    "engagementId" | "sessionId" | "pricePaidMinor" | "sessionsPurchased" | "currency"
  >,
): Promise<void> {
  const sessionMinor = perSessionMinor(session);
  const { tutorMinor } = splitMinor(sessionMinor);

  await record(tx, [
    {
      engagementId: session.engagementId,
      sessionId: session.sessionId,
      type: "session_earned",
      amountMinor: sessionMinor,
      currency: session.currency,
    },
    {
      engagementId: session.engagementId,
      sessionId: session.sessionId,
      type: "tutor_payout",
      amountMinor: tutorMinor,
      currency: session.currency,
    },
  ]);
}

async function closeIfDelivered(
  tx: Tx,
  engagementId: string,
  sessionsPurchased: number,
  now: Date,
): Promise<void> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sessionBooking)
    .where(
      and(
        eq(sessionBooking.engagementId, engagementId),
        eq(sessionBooking.status, "completed"),
      ),
    );

  if ((rows.at(0)?.n ?? 0) < sessionsPurchased) return;

  await tx
    .update(engagement)
    .set({ status: "completed", completedAt: now })
    .where(and(eq(engagement.id, engagementId), eq(engagement.status, "active")));
}

async function applySettlement(
  tx: Tx,
  session: SessionContextRow,
  outcome: Settlement,
  now: Date,
): Promise<void> {
  await tx
    .update(sessionBooking)
    .set({ status: statusFor(outcome), resolution: outcome.resolution })
    .where(
      and(eq(sessionBooking.id, session.sessionId), eq(sessionBooking.status, "scheduled")),
    );

  if (outcome.delivered) {
    await recognise(tx, session);
    await closeIfDelivered(tx, session.engagementId, session.sessionsPurchased, now);
  }

  if (outcome.studentFact) {
    await tx.insert(reliabilityEvent).values({
      userId: session.studentUserId,
      sessionId: session.sessionId,
      type: outcome.studentFact,
      occurredAt: now,
    });
  }
}

async function settleLocked(tx: Tx, sessionId: string, now: Date): Promise<SessionOutcome> {
  const rows = await sessionContext(tx).where(eq(sessionBooking.id, sessionId)).limit(1);
  const session = rows.at(0);
  if (!session) throw new SessionError("That session does not exist.");

  if (session.status !== "scheduled") {
    return { sessionId, status: session.status, resolution: session.resolution };
  }

  const outcome = settle(session, now);
  if (!outcome) return { sessionId, status: "scheduled", resolution: null };

  await applySettlement(tx, session, outcome, now);

  return {
    sessionId,
    status: statusFor(outcome),
    resolution: outcome.resolution,
  };
}

function statusFor(outcome: Settlement): SessionOutcome["status"] {
  if (outcome.resolution === "disputed") return "disputed";
  return outcome.delivered ? "completed" : "cancelled";
}

function assertAnswerable(session: SessionContextRow, now: Date): void {
  if (session.status !== "scheduled") {
    throw new SessionError("That session has already been settled.");
  }
  if (now.getTime() < sessionEndsAt(session.scheduledAt, session.durationMinutes).getTime()) {
    throw new SessionError("You can answer once the session has finished.");
  }
}

export type SessionOutcome = {
  sessionId: string;
  status: SessionContextRow["status"];
  resolution: SessionContextRow["resolution"];
};

export async function confirmAttendance(params: {
  actor: Actor;
  sessionId: string;
}): Promise<SessionOutcome> {
  const now = new Date();

  return db.transaction(async (tx) => {
    await lockSession(tx, params.sessionId);
    const session = await loadParticipation({
      exec: tx,
      sessionId: params.sessionId,
      actor: params.actor,
    });
    assertAnswerable(session, now);

    const mine =
      session.role === "student"
        ? { confirmed: session.studentConfirmedAt, denied: session.studentDeniedAt }
        : { confirmed: session.tutorConfirmedAt, denied: session.tutorDeniedAt };

    if (mine.denied) throw new SessionError("You already said this did not happen.");

    if (!mine.confirmed) {
      await tx
        .update(sessionBooking)
        .set(
          session.role === "student"
            ? { studentConfirmedAt: now }
            : { tutorConfirmedAt: now },
        )
        .where(eq(sessionBooking.id, session.sessionId));
    }

    return settleLocked(tx, session.sessionId, now);
  });
}

export async function denyAttendance(params: {
  actor: Actor;
  sessionId: string;
  note?: string | null;
}): Promise<SessionOutcome> {
  const now = new Date();

  return db.transaction(async (tx) => {
    await lockSession(tx, params.sessionId);
    const session = await loadParticipation({
      exec: tx,
      sessionId: params.sessionId,
      actor: params.actor,
    });
    assertAnswerable(session, now);

    const mine =
      session.role === "student"
        ? { confirmed: session.studentConfirmedAt, denied: session.studentDeniedAt }
        : { confirmed: session.tutorConfirmedAt, denied: session.tutorDeniedAt };

    if (mine.confirmed) throw new SessionError("You already confirmed this session.");

    if (!mine.denied) {
      const note = params.note?.trim() ? params.note.trim() : session.denialNote;
      await tx
        .update(sessionBooking)
        .set(
          session.role === "student"
            ? { studentDeniedAt: now, denialNote: note }
            : { tutorDeniedAt: now, denialNote: note },
        )
        .where(eq(sessionBooking.id, session.sessionId));
    }

    return settleLocked(tx, session.sessionId, now);
  });
}

export async function releaseLapsedConfirmations(): Promise<number> {
  const now = new Date();

  const due = await db
    .select({ id: sessionBooking.id })
    .from(sessionBooking)
    .where(
      and(
        eq(sessionBooking.status, "scheduled"),
        lte(sessionBooking.confirmationWindowEndsAt, now),
      ),
    )
    .limit(200);

  let released = 0;
  for (const row of due) {
    const outcome = await db.transaction(async (tx) => {
      await lockSession(tx, row.id);
      return settleLocked(tx, row.id, now);
    });
    if (outcome.status !== "scheduled") released += 1;
  }

  return released;
}

/** TODO(admin): no admin role exists, so this trusts the caller's user id. */
export async function resolveDispute(params: {
  sessionId: string;
  resolvedByUserId: string;

  attended: boolean;

  studentNoShowed?: boolean;
}): Promise<SessionOutcome> {
  const now = new Date();

  return db.transaction(async (tx) => {
    await lockSession(tx, params.sessionId);

    const rows = await sessionContext(tx)
      .where(eq(sessionBooking.id, params.sessionId))
      .limit(1);

    const session = rows.at(0);
    if (!session) throw new SessionError("That session does not exist.");
    if (session.status !== "disputed") {
      throw new SessionError("That session is not disputed.");
    }

    const resolution = params.attended ? "resolved_attended" : "resolved_not_attended";
    const status = params.attended ? "completed" : "cancelled";

    await tx
      .update(sessionBooking)
      .set({ status, resolution })
      .where(
        and(eq(sessionBooking.id, params.sessionId), eq(sessionBooking.status, "disputed")),
      );

    if (params.attended) {
      await recognise(tx, session);
      await closeIfDelivered(tx, session.engagementId, session.sessionsPurchased, now);
    }

    const fact = params.studentNoShowed
      ? "no_showed"
      : params.attended
        ? "attended"
        : null;

    if (fact) {
      await tx.insert(reliabilityEvent).values({
        userId: session.studentUserId,
        sessionId: session.sessionId,
        type: fact,
        occurredAt: now,
      });
    }

    return { sessionId: params.sessionId, status, resolution };
  });
}
