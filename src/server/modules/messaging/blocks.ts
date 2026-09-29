import { and, eq, sql, type Column, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import { userBlock } from "@/server/db/schema";

type UserRef = Column | SQL | string;

export function blockedBetween(a: UserRef, b: UserRef): SQL {
  return sql`exists (
    select 1 from ${userBlock}
    where (${userBlock.blockerUserId} = ${a} and ${userBlock.blockedUserId} = ${b})
       or (${userBlock.blockerUserId} = ${b} and ${userBlock.blockedUserId} = ${a})
  )`;
}

export async function setBlock(params: {
  blockerUserId: string;
  blockedUserId: string;
  institutionId: string;
  blocked: boolean;
}): Promise<void> {
  if (params.blocked) {
    await db
      .insert(userBlock)
      .values({
        blockerUserId: params.blockerUserId,
        blockedUserId: params.blockedUserId,
        institutionId: params.institutionId,
      })
      .onConflictDoNothing();
    return;
  }

  await db
    .delete(userBlock)
    .where(
      and(
        eq(userBlock.blockerUserId, params.blockerUserId),
        eq(userBlock.blockedUserId, params.blockedUserId),
      ),
    );
}
