import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { sweepLease } from "@/server/db/schema";

/** `held_until` exactly as Postgres stores it. A JS Date drops the microseconds, and release would never match. */
export type Lease = string & { readonly __brand: "Lease" };

/**
 * One holder per campus and name, claimed in a single statement and held by a timestamp rather than a
 * lock or an open transaction, so Stripe calls can run under it. A crashed holder's lease lapses after `ttlMs`.
 * Every time is read off the database's clock, so the app server's clock never decides who holds it.
 * Returns the lease, or null when someone else holds it.
 */
export async function claim(institutionId: string, name: string, ttlMs: number): Promise<Lease | null> {
  const [claimed] = await db
    .insert(sweepLease)
    .values({ institutionId, name, heldUntil: sql`now() + ${ttlMs} * interval '1 millisecond'` })
    .onConflictDoUpdate({
      target: [sweepLease.institutionId, sweepLease.name],
      set: { heldUntil: sql`excluded.held_until` },
      setWhere: lt(sweepLease.heldUntil, sql`now()`),
    })
    .returning({ heldUntil: sql<string>`${sweepLease.heldUntil}::text` });
  return claimed ? (claimed.heldUntil as Lease) : null;
}

export async function withLease<T>(
  institutionId: string,
  name: string,
  ttlMs: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const lease = await claim(institutionId, name, ttlMs);
  if (!lease) return null;

  try {
    return await work();
  } finally {
    await release(institutionId, name, lease);
  }
}

/** Lets the lease go, unless it lapsed and someone else claimed it since. */
export async function release(institutionId: string, name: string, lease: Lease): Promise<void> {
  await db
    .update(sweepLease)
    .set({ heldUntil: new Date(0) })
    .where(and(eq(sweepLease.institutionId, institutionId), eq(sweepLease.name, name), sql`${sweepLease.heldUntil} = ${lease}::timestamptz`));
}
