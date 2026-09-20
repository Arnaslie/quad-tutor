/**
 * Settling a session: the mutual confirm, the auto-release sweep, and the one
 * place deferred revenue becomes recognised revenue.
 *
 * The rules live in `attendance.ts`, which is pure. This file is the part that
 * has to touch a database and a clock: it loads the row, locks it, asks
 * `settle()` what the answers add up to, and writes the consequences — the
 * session's state, the ledger entries, and the reliability fact if there is
 * one — inside a single transaction. Nothing here decides anything; if you are
 * looking for why an outcome is what it is, it is in `attendance.ts`.
 *
 * Recognition is the invariant worth restating (ledger.ts has the long form):
 * a package purchased up front is deferred revenue. A session delivered is
 * what converts it. `session_earned` and `tutor_payout` are written together,
 * per session, in the same transaction as the state change, and
 * `platform_fee` is deliberately not written — it is exactly the difference
 * between the two and storing it invites the three to disagree.
 */

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

/**
 * A delivered session, recognised. Two rows, always together:
 *
 *   `session_earned` — revenue, derived from what the student actually paid
 *                      for this package rather than today's list price.
 *   `tutor_payout`   — the tutor's share, accrued as a liability. It is owed
 *                      from this moment; moving the money is a separate act.
 *
 * TODO(stripe): the transfer against this accrual belongs in a payout run, not
 * here. The ledger is what says how much is owed; Stripe's balance is float.
 */
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

/** The package is done once every purchased session has been delivered. */
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

/**
 * Write the consequences of a settlement. Every write is in the caller's
 * transaction, alongside the state change, so a session can never be marked
 * delivered without the ledger rows that make it revenue.
 */
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

  // Facts only, and only about the student. A tutor's reliability lives in the
  // hidden per-course quality score, never in this table — the two histories
  // are kept separate because the same person is routinely both.
  if (outcome.studentFact) {
    await tx.insert(reliabilityEvent).values({
      userId: session.studentUserId,
      sessionId: session.sessionId,
      type: outcome.studentFact,
      occurredAt: now,
    });
  }
}

/**
 * Re-read under the lock and settle if the answers now add up to something.
 * Returns where the session ended up, derived from the settlement rather than
 * read back — the row it would re-read is the one this transaction just wrote.
 */
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

/**
 * Not delivered means the booking is voided and the session returns to the
 * package, where it can be rebooked or refunded at term end.
 *
 * Note this leaves `cancelledAt` and `cancelledByUserId` null, deliberately:
 * nobody cancelled this session, it did not happen, and `resolution` is what
 * says so. Those two columns mean "a person called this off in advance" and
 * the stats job reads them as exactly that — see `cancelSession`.
 */
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

/**
 * "It happened." Either party; whoever the actor is on this session.
 *
 * Confirming twice is a no-op rather than an error — a double-tapped button
 * must not look like a failure — but changing your answer is refused, because
 * the other side may already have acted on it.
 */
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

/**
 * "It did not happen." The asymmetry is deliberate and is what lets a
 * `no_showed` fact exist without anyone giving a subjective read:
 *
 *   - a **tutor** denying means *the student did not show up* — a tutor who
 *     cannot make it cancels instead;
 *   - a **student** denying means the session did not happen, for any reason.
 *
 * Denying against a confirmation is a dispute, and a dispute never settles
 * itself. `note` is what the human reviewing it reads.
 */
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

/**
 * Auto-release. A lapsed confirmation window defaults to attended, because
 * leaving a tutor unpaid on a student's silence destroys the scarce side of
 * the marketplace — but it writes no reliability fact out of that silence.
 *
 * Swept lazily on read, matching `expireStaleRequests` in the matching module:
 * a cron would be tidier, and this is the seam where one would attach, but at
 * campus scale every path that cares calls this first and that is enough.
 */
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

/**
 * Human resolution of a dispute. At launch volume this is a person reading the
 * two denial notes and making a call — docs/decisions.md says so explicitly,
 * and pretending otherwise would mean inventing an adjudication rule the
 * product cannot defend.
 *
 * TODO(admin): there is no admin role in the schema, so this takes the
 * resolver's user id on trust. It must not be reachable from a student or
 * tutor route until there is one.
 */
export async function resolveDispute(params: {
  sessionId: string;
  resolvedByUserId: string;
  /** True when the session is treated as delivered: the tutor is paid. */
  attended: boolean;
  /** Writes the one fact a reviewer is allowed to establish. */
  studentNoShowed?: boolean;
  /* `resolvedByUserId` is not persisted: there is no audit table yet, and
     inventing one is a schema change this draft does not need. */
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
