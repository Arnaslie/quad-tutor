import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { EmailError, sendEmail } from "./email";

const env = process.env as Record<string, string | undefined>;
const KEYS = ["EMAIL_TRANSPORT", "VERCEL_ENV", "NODE_ENV", "RESEND_API_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

const message = { to: "someone@example.com", subject: "Your sign-in link", text: "Tap to sign in." };

test("log transport refuses to run on a Vercel production deploy", async () => {
  Object.assign(env, { EMAIL_TRANSPORT: "log", VERCEL_ENV: "production", NODE_ENV: "production", RESEND_API_KEY: "re_test" });

  await assert.rejects(sendEmail(message), (error) => {
    assert.ok(error instanceof EmailError);
    assert.equal(error.message, "EMAIL_TRANSPORT=log is set in production — refusing to drop mail silently.");
    return true;
  });
});

test("log transport prints instead of sending under a production build with a key set", async (t) => {
  Object.assign(env, { EMAIL_TRANSPORT: "log", NODE_ENV: "production", RESEND_API_KEY: "re_test" });
  delete env.VERCEL_ENV;
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw new Error("log transport must not call Resend");
  });
  const log = t.mock.method(console, "log", () => {});

  await sendEmail(message);

  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ["\n[email] to: someone@example.com", "[email] subject: Your sign-in link", "Tap to sign in.\n"],
  );
});
