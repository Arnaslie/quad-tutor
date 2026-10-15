import { sql } from "drizzle-orm";

import { db } from "../index";

const PERSONA_LOCK = 0x5045;

export async function holdingPersonas<T>(
  institutionId: string,
  hold: "reset" | "send",
  work: () => Promise<T>,
): Promise<T | undefined> {
  return db.transaction(async (tx) => {
    const key = sql`${PERSONA_LOCK}::int, hashtext(${institutionId})`;
    const [{ locked }] = await tx.execute<{ locked: boolean }>(
      hold === "reset"
        ? sql`select pg_try_advisory_xact_lock(${key}) as locked`
        : sql`select pg_try_advisory_xact_lock_shared(${key}) as locked`,
    );
    return locked ? work() : undefined;
  });
}
