import { defineConfig } from "@playwright/test";

import { env } from "./e2e/env";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: env.BETTER_AUTH_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run start -- --port ${new URL(env.BETTER_AUTH_URL).port || 3000}`,
    url: env.BETTER_AUTH_URL,
    env: { STRIPE_FAKE: "1", EMAIL_TRANSPORT: "log" },
    stdout: "pipe",
    timeout: 120_000,
  },
});
