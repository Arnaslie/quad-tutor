import { execFileSync } from "node:child_process";
import type { Config } from "drizzle-kit";

if (process.argv.some((arg) => arg === "migrate" || arg === "push")) {
  try {
    execFileSync(process.execPath, ["./src/server/db/migrate-guard.mjs"], { stdio: "inherit" });
  } catch {
    process.exit(1);
  }
}

export default {
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;
