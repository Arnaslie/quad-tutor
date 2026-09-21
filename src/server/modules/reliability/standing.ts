export const MAX_PARALLEL_ASKS = 3;

const RECOVERY_WINDOW = 3;

export type ReliabilityFact = {
  type: "attended" | "late_cancelled" | "no_showed" | "payment_failed";
  occurredAt: Date;
};

export type Standing = {
  parallelAskLimit: number;

  depositRequired: boolean;

  cleanSessionsToRecover: number;
};

export const CLEAN_STANDING: Standing = {
  parallelAskLimit: MAX_PARALLEL_ASKS,
  depositRequired: false,
  cleanSessionsToRecover: 0,
};

export function standingFrom(facts: readonly ReliabilityFact[]): Standing {
  const newestFirst = [...facts].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime(),
  );

  let attendedSeen = 0;
  let liveStrikes = 0;

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
