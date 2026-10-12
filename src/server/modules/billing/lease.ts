import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { sweepLease } from "@/server/db/schema";

/**
 * One holder per campus and name, claimed in a single statement and held by a timestamp rather than a
 * lock or an open transaction, so Stripe calls can run under it. A crashed holder's lease lapses after `ttlMs`.
 * Returns when the lease ends, or null when someone else holds it.
 */
export async function claim(institutionId: string, name: string, ttlMs: number): Promise<Date | null> {
  const heldUntil = new Date(Date.now() + ttlMs);
  const claimed = await db
    .insert(sweepLease)
    .values({ institutionId, name, heldUntil })
    .onConflictDoUpdate({
      target: [sweepLease.institutionId, sweepLease.name],
      set: { heldUntil },
      setWhere: lt(sweepLease.heldUntil, sql`now()`),
    })
    .returning({ heldUntil: sweepLease.heldUntil });
  return claimed.length > 0 ? heldUntil : null;
}

export async function withLease<T>(
  institutionId: string,
  name: string,
  ttlMs: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const heldUntil = await claim(institutionId, name, ttlMs);
  if (!heldUntil) return null;

  try {
    return await work();
  } finally {
    await db
      .update(sweepLease)
      .set({ heldUntil: new Date(0) })
      .where(
        and(eq(sweepLease.institutionId, institutionId), eq(sweepLease.name, name), eq(sweepLease.heldUntil, heldUntil)),
      );
  }
}
