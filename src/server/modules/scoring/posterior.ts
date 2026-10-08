export const PRIOR_STRENGTH = 5;
export const PRIOR_MIN_SAMPLES = 20;

const BP = 10_000;
const BP_PER_STAR = BP / 4;

export type Pool = { samples: number; totalBp: number };

export const EMPTY_POOL: Pool = { samples: 0, totalBp: 0 };

export function starsToBp(stars: number): number {
  return (stars - 1) * BP_PER_STAR;
}

export const STAR_PRIOR_BP = starsToBp(4);
export const RENEWAL_PRIOR_BP = 4_000;

export function starPool(count: number, starSum: number): Pool {
  return { samples: count, totalBp: (starSum - count) * BP_PER_STAR };
}

export function renewalPool(trials: number, successes: number): Pool {
  return { samples: trials, totalBp: successes * BP };
}

export function addPools(a: Pool, b: Pool): Pool {
  return { samples: a.samples + b.samples, totalBp: a.totalBp + b.totalBp };
}

export function priorBp(course: Pool, campus: Pool, fallbackBp: number): number {
  for (const pool of [course, campus]) {
    if (pool.samples >= PRIOR_MIN_SAMPLES) return pool.totalBp / pool.samples;
  }
  return fallbackBp;
}

export function posteriorBp(own: Pool, prior: number): number {
  return Math.round((PRIOR_STRENGTH * prior + own.totalBp) / (PRIOR_STRENGTH + own.samples));
}
