/**
 * Student-side standing. Pure — facts in, mechanics out, no I/O and no clock
 * beyond what the caller passes.
 *
 * The product principle this encodes (docs/decisions.md) is narrow and worth
 * restating, because it is easy to erode:
 *
 *   - Inputs are timestamped facts only. Nothing subjective, nothing that
 *     proxies for academic ability.
 *   - Output is platform mechanics — a deposit, fewer parallel asks — never a
 *     score, badge or number shown to anyone.
 *   - It is always recoverable. Three clean sessions clears anything.
 *
 * Prevention (T-12h confirm, auto-release, check-in) comes before any penalty,
 * so this only ever sees what prevention failed to catch.
 */

/** The ceiling. Standing can lower a student's allowance, never raise it. */
export const MAX_PARALLEL_ASKS = 3;

/** How many attended sessions it takes to clear a strike. */
const RECOVERY_WINDOW = 3;

export type ReliabilityFact = {
  type: "attended" | "late_cancelled" | "no_showed" | "payment_failed";
  occurredAt: Date;
};

export type Standing = {
  parallelAskLimit: number;
  /** A held deposit, not a fee — returned when the session is attended. */
  depositRequired: boolean;
  /** 0 when clean. Drives the "you're back to normal after N" copy. */
  cleanSessionsToRecover: number;
};

export const CLEAN_STANDING: Standing = {
  parallelAskLimit: MAX_PARALLEL_ASKS,
  depositRequired: false,
  cleanSessionsToRecover: 0,
};

/**
 * A strike is "live" until three attended sessions have happened since it. That
 * is the whole rule — walking newest-first and stopping at the third attended
 * session yields exactly the set of facts still holding someone back.
 */
export function standingFrom(facts: readonly ReliabilityFact[]): Standing {
  const newestFirst = [...facts].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );

  let attendedSeen = 0;
  let liveStrikes = 0;
  /** Attended sessions that happened *after* the oldest strike still counting. */
  let attendedSinceOldestStrike = 0;

  for (const fact of newestFirst) {
    if (fact.type === "attended") {
      attendedSeen += 1;
      if (attendedSeen >= RECOVERY_WINDOW) break;
      continue;
    }

    liveStrikes += 1;
    attendedSinceOldestStrike = attendedSeen;
  }

  if (liveStrikes === 0) return CLEAN_STANDING;

  return {
    parallelAskLimit: liveStrikes === 1 ? 2 : 1,
    depositRequired: liveStrikes >= 2,
    cleanSessionsToRecover: Math.max(0, RECOVERY_WINDOW - attendedSinceOldestStrike),
  };
}
