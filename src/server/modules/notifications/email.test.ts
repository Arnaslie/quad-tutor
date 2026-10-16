import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";

import { EmailError, sendEmail, type Email } from "./email";
import { requestAccepted, signInLink } from "./messages";

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

async function resendBody(t: TestContext, email: Email): Promise<Record<string, unknown>> {
  Object.assign(env, { RESEND_API_KEY: "re_test" });
  delete env.EMAIL_TRANSPORT;
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  await sendEmail(email);
  assert.equal(fetch.mock.callCount(), 1);
  const init = fetch.mock.calls[0].arguments[1] as RequestInit;
  return JSON.parse(init.body as string);
}

const accepted = (to: string) =>
  requestAccepted({ to, studentName: "Sam", tutorName: "Riley", courseLabel: "MATH 125" });

test("a persona's notification is copied to the test reader", async (t) => {
  const body = await resendBody(t, accepted("arnutislie12+student-new@gmail.com"));

  assert.deepEqual(body.to, ["arnutislie12+student-new@gmail.com"]);
  assert.deepEqual(body.bcc, ["jmgucius@crimson.ua.edu"]);
});

test("a real user's notification is not copied", async (t) => {
  const body = await resendBody(t, accepted("sam@crimson.ua.edu"));

  assert.deepEqual(body.to, ["sam@crimson.ua.edu"]);
  assert.equal("bcc" in body, false);
});

test("a persona's sign-in link is copied to the test reader", async (t) => {
  const body = await resendBody(t, signInLink({ to: "arnutislie12+ops@gmail.com", link: "http://localhost:3000/sign-in/verify?token=x" }));

  assert.deepEqual(body.to, ["arnutislie12+ops@gmail.com"]);
  assert.equal(body.subject, "Quad Tutor sign-in link");
  assert.deepEqual(body.bcc, ["jmgucius@crimson.ua.edu"]);
});

test("log transport shows the persona copy", async (t) => {
  Object.assign(env, { EMAIL_TRANSPORT: "log" });
  delete env.VERCEL_ENV;
  const log = t.mock.method(console, "log", () => {});

  await sendEmail({ to: "arnutislie12+tutor-new@gmail.com", subject: "Hi", text: "Body" });

  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments[0]),
    ["\n[email] to: arnutislie12+tutor-new@gmail.com", "[email] bcc: jmgucius@crimson.ua.edu", "[email] subject: Hi", "Body\n"],
  );
});
