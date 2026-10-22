import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, test, type TestContext } from "node:test";

import { inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import { user } from "@/server/db/schema";

import { EmailError, sendEmail, type Email } from "./email";
import { requestAccepted, signInLink } from "./messages";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const made: string[] = [];

before(async () => {
  const accounts = [
    { id: `persona_student-new.${run}`, email: "arnutislie12+student-new@gmail.com" },
    { id: `persona_tutor-new.${run}`, email: "arnutislie12+tutor-new@gmail.com" },
    { id: `test_ops_${run}`, email: "arnutislie12+ops@gmail.com" },
    { id: `test_real_${run}`, email: "sam@crimson.ua.edu" },
  ];
  const inserted = await db
    .insert(user)
    .values(accounts.map((account) => ({ ...account, name: account.id, emailVerified: true })))
    .onConflictDoNothing({ target: user.email })
    .returning({ id: user.id });
  made.push(...inserted.map((row) => row.id));
  const rows = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.email, accounts.map((a) => a.email)));
  assert.deepEqual(
    rows.map((row) => [row.email, row.id.startsWith("persona_")]).sort(),
    [
      ["arnutislie12+ops@gmail.com", false],
      ["arnutislie12+student-new@gmail.com", true],
      ["arnutislie12+tutor-new@gmail.com", true],
      ["sam@crimson.ua.edu", false],
    ],
  );
});

after(async () => {
  if (made.length > 0) await db.delete(user).where(inArray(user.id, made));
  await db.$client.end();
});

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
  requestAccepted({
    to,
    studentName: "Sam",
    tutorName: "Riley",
    courseLabel: "MATH 125",
    askedRateMinor: null,
    quotedRateMinor: null,
  });

test("a persona's notification is copied to the test reader, whatever the address case", async (t) => {
  const body = await resendBody(t, accepted("Arnutislie12+Student-New@Gmail.com"));

  assert.deepEqual(body.to, ["Arnutislie12+Student-New@Gmail.com"]);
  assert.deepEqual(body.bcc, ["jmgucius@crimson.ua.edu"]);
});

test("a real user's notification is not copied", async (t) => {
  const body = await resendBody(t, accepted("sam@crimson.ua.edu"));

  assert.deepEqual(body.to, ["sam@crimson.ua.edu"]);
  assert.equal("bcc" in body, false);
});

test("a persona's sign-in link is copied to the test reader", async (t) => {
  const body = await resendBody(t, signInLink({ to: "arnutislie12+student-new@gmail.com", link: "http://localhost:3000/sign-in/verify?token=x" }));

  assert.deepEqual(body.to, ["arnutislie12+student-new@gmail.com"]);
  assert.equal(body.subject, "Quad Tutor sign-in link");
  assert.deepEqual(body.bcc, ["jmgucius@crimson.ua.edu"]);
});

test("the operator's notification is not copied, though it is on the persona inbox", async (t) => {
  const body = await resendBody(t, accepted("arnutislie12+ops@gmail.com"));

  assert.deepEqual(body.to, ["arnutislie12+ops@gmail.com"]);
  assert.equal("bcc" in body, false);
});

test("the operator's sign-in link is not copied", async (t) => {
  const body = await resendBody(t, signInLink({ to: "arnutislie12+ops@gmail.com", link: "http://localhost:3000/sign-in/verify?token=x" }));

  assert.deepEqual(body.to, ["arnutislie12+ops@gmail.com"]);
  assert.equal(body.subject, "Quad Tutor sign-in link");
  assert.equal("bcc" in body, false);
});

test("an inbox alias with no account is not copied", async (t) => {
  const body = await resendBody(t, accepted("arnutislie12+nobody@gmail.com"));

  assert.equal("bcc" in body, false);
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
