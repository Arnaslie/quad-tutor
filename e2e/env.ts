import { z } from "zod";

import { isLocalHost } from "../src/server/db/local-host.mjs";

export const env = z
  .object({
    BETTER_AUTH_URL: z.url(),
    DATABASE_URL: z.string().min(1),
    CRON_SECRET: z.string().min(1),
  })
  .parse(process.env);

const host = new URL(env.DATABASE_URL).hostname;
if (!isLocalHost(host)) {
  throw new Error(`Refusing to drive workflows against a remote database (${host}).`);
}
