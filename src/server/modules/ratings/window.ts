import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { ledgerEntry } from "@/server/db/schema";

import { WINDOW_DAYS } from "./rules";

export class RatingError extends Error {}

export function earnedAt(sessionId: AnyPgColumn, institutionId: AnyPgColumn | string): SQL<Date | null> {
  return sql<Date | null>`(
    select min(${ledgerEntry.occurredAt}) from ${ledgerEntry}
    where ${ledgerEntry.sessionId} = ${sessionId}
      and ${ledgerEntry.institutionId} = ${institutionId}
      and ${ledgerEntry.type} = 'session_earned'
  )`.mapWith(toDate);
}

function toDate(value: string | Date | null): Date | null {
  return value === null ? null : new Date(value);
}

export function closesAt(earned: SQL): SQL<Date | null> {
  return sql<Date | null>`(${earned} + make_interval(days => ${WINDOW_DAYS}))`.mapWith(toDate);
}
