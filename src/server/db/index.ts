import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema> & {
  $client: ReturnType<typeof postgres>;
};

let instance: Database | null = null;

/**
 * Connect on first query, not on import. `next build` imports route modules to
 * collect their config, so connecting at module evaluation makes a build fail
 * without a credential it never uses.
 */
function connect(): Database {
  if (instance) return instance;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env.local");
  }

  instance = drizzle(postgres(connectionString, { prepare: false }), { schema }) as Database;
  return instance;
}

export const db = new Proxy({} as Database, {
  get(_target, property) {
    const target = connect();
    const value = Reflect.get(target, property) as unknown;
    if (typeof value !== "function") return value;

    // Wrapped rather than bound: `bind` returns a bare function, which drops
    // the methods postgres-js hangs off its client (`$client.end`).
    return new Proxy(value, {
      apply: (fn, _thisArg, args) => Reflect.apply(fn as (...a: unknown[]) => unknown, target, args),
    });
  },
});

export { schema };
