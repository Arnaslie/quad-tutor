import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import { institution, studentProfile, tutorProfile, user } from "@/server/db/schema";
import type { TutorActor } from "@/server/modules/identity/actor";

import { choosePayoutSpeed, ensureConnectAccount, onboardingLink, payoutsFor } from "./connect";
import type { PayoutSpeed } from "./payout-speed";
import { GatewayError, fakeStripe, signWebhookPayload, stripeGateway } from "./stripe";
import { handleStripeWebhook } from "./webhook";

process.env.STRIPE_FAKE = "1";
process.env.STRIPE_WEBHOOK_SECRET = `whsec_${randomBytes(16).toString("hex")}`;
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = `whsec_${randomBytes(16).toString("hex")}`;

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const run = randomUUID().slice(0, 8);
const users: string[] = [];
const institutions: string[] = [];

async function campus(): Promise<string> {
  const [row] = await db
    .insert(institution)
    .values({ name: "Test connect", slug: `connect-${run}-${institutions.length}`, emailDomain: `connect-${run}-${institutions.length}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  institutions.push(row.id);
  return row.id;
}

let home: string;
let people = 0;
async function tutor(institutionId = home): Promise<TutorActor> {
  const id = `test_connect_${run}_${(people += 1)}`;
  await db.insert(user).values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  users.push(id);
  const [student] = await db.insert(studentProfile).values({ userId: id, institutionId }).returning({ id: studentProfile.id });
  const [profile] = await db.insert(tutorProfile).values({ userId: id, institutionId }).returning({ id: tutorProfile.id });
  return { userId: id, name: id, email: `${id}@example.test`, institutionId, studentProfileId: student.id, tutorProfileId: profile.id };
}

async function profile(actor: TutorActor) {
  const [row] = await db
    .select({ accountId: tutorProfile.stripeAccountId, status: tutorProfile.kycStatus, speed: tutorProfile.payoutSpeed })
    .from(tutorProfile)
    .where(eq(tutorProfile.id, actor.tutorProfileId));
  return row;
}

async function deliver(event: { payload: string; signature: string }) {
  return handleStripeWebhook(event.payload, event.signature);
}

/** Runs `work` with every schedule change Stripe would be sent recorded, in order. */
async function scheduleCalls(work: () => Promise<unknown>): Promise<[string, PayoutSpeed][]> {
  const calls: [string, PayoutSpeed][] = [];
  const real = stripeGateway().setPayoutSpeed;
  stripeGateway().setPayoutSpeed = (accountId, speed) => {
    calls.push([accountId, speed]);
    return real(accountId, speed);
  };
  try {
    await work();
  } finally {
    stripeGateway().setPayoutSpeed = real;
  }
  return calls;
}

before(async () => {
  home = await campus();
});

after(async () => {
  await db.delete(tutorProfile).where(inArray(tutorProfile.userId, users));
  await db.delete(studentProfile).where(inArray(studentProfile.userId, users));
  await db.delete(user).where(inArray(user.id, users));
  await db.delete(institution).where(inArray(institution.id, institutions));
  await db.$client.end();
});

test("an account is created once per tutor and stamped on the profile", async () => {
  const actor = await tutor();
  const created = stripeGateway().createAccount;
  let calls = 0;
  stripeGateway().createAccount = (params) => {
    calls += 1;
    return created(params);
  };
  try {
    const [first, second] = await Promise.all([ensureConnectAccount(actor), ensureConnectAccount(actor)]);
    assert.equal(first, second);
    assert.equal(await ensureConnectAccount(actor), first);
    assert.ok(calls <= 2);
  } finally {
    stripeGateway().createAccount = created;
  }
  const row = await profile(actor);
  const account = await stripeGateway().retrieveAccount(row.accountId!);
  assert.deepEqual([account.tutorProfileId, account.institutionId], [actor.tutorProfileId, home]);
  assert.equal(row.status, "not_started");
});

test("onboarding mints a link back to /tutor/payouts, and the return page re-reads Stripe", async () => {
  const actor = await tutor();
  const url = await onboardingLink(actor);
  const link = await fakeStripe.accountLink(new URL(url).pathname.split("/").at(-1)!);
  assert.match(link.returnUrl, /\/tutor\/payouts$/);
  assert.match(link.refreshUrl, /\/tutor\/payouts\/refresh$/);
  assert.equal((await payoutsFor(actor)).status, "not_started");

  await fakeStripe.setAccount(link.accountId, "verified");
  assert.deepEqual(await payoutsFor(actor), { accountId: link.accountId, status: "verified", stage: "verified", speed: "weekly" });
  assert.equal((await profile(actor)).status, "verified");

  await fakeStripe.setAccount(link.accountId, "rejected");
  assert.deepEqual(await payoutsFor(actor), {
    accountId: link.accountId,
    status: "restricted",
    stage: "needs_support",
    speed: "weekly",
  });
});

test("account.updated on the Connect secret maps each state, and a stale payload never wins", async () => {
  const actor = await tutor();
  const accountId = await ensureConnectAccount(actor);
  const stale = await stripeGateway().retrieveAccount(accountId);

  for (const state of ["pending", "restricted", "verified"] as const) {
    await fakeStripe.setAccount(accountId, state);
    const result = await deliver(await fakeStripe.accountEvent(accountId));
    assert.deepEqual(result, { status: 200, outcome: "kyc_synced", institutionId: home });
    assert.equal((await profile(actor)).status, state);
  }

  await deliver(await fakeStripe.accountEvent(accountId, stale));
  assert.equal((await profile(actor)).status, "verified");
});

test("the webhook refuses a bad signature and a livemode mismatch, and ignores unknown accounts", async () => {
  const actor = await tutor();
  const accountId = await ensureConnectAccount(actor);
  const event = await fakeStripe.accountEvent(accountId);
  assert.equal((await handleStripeWebhook(event.payload, signWebhookPayload(event.payload, "whsec_wrong"))).status, 400);

  const live = JSON.stringify({ ...JSON.parse(event.payload), livemode: true });
  assert.deepEqual(await handleStripeWebhook(live, signWebhookPayload(live, process.env.STRIPE_CONNECT_WEBHOOK_SECRET)), {
    status: 400,
    reason: "livemode mismatch",
  });

  const unknown = JSON.stringify({ ...JSON.parse(event.payload), account: "acct_fake_unknown" });
  assert.deepEqual(await handleStripeWebhook(unknown, signWebhookPayload(unknown)), {
    status: 200,
    outcome: "foreign",
    institutionId: null,
  });
});

test("an account is only applied on the campus its metadata names", async () => {
  const away = await campus();
  const actor = await tutor(away);
  const accountId = await ensureConnectAccount(actor);
  await db.update(tutorProfile).set({ institutionId: home }).where(eq(tutorProfile.id, actor.tutorProfileId));
  await fakeStripe.setAccount(accountId, "verified");
  assert.deepEqual(await deliver(await fakeStripe.accountEvent(accountId)), { status: 200, outcome: "foreign", institutionId: null });
  assert.equal((await profile(actor)).status, "not_started");
});

test("an account whose metadata names another tutor, or that Stripe won't let us read, is foreign", async () => {
  const actor = await tutor();
  const other = await tutor();
  const accountId = await ensureConnectAccount(actor);
  await fakeStripe.setAccount(accountId, "verified");
  const retrieve = stripeGateway().retrieveAccount;
  try {
    stripeGateway().retrieveAccount = async (id) => ({ ...(await retrieve(id)), tutorProfileId: other.tutorProfileId });
    assert.deepEqual(await deliver(await fakeStripe.accountEvent(accountId)), { status: 200, outcome: "foreign", institutionId: null });
    assert.equal((await profile(actor)).status, "not_started");

    stripeGateway().retrieveAccount = async () => {
      throw new GatewayError("The provided key does not have access to account", { status: 403, type: "invalid_request_error" });
    };
    assert.deepEqual(await deliver(await fakeStripe.accountEvent(accountId)), { status: 200, outcome: "foreign", institutionId: null });
  } finally {
    stripeGateway().retrieveAccount = retrieve;
  }
  assert.equal((await stripeGateway().retrieveAccount(accountId)).tutorProfileId, actor.tutorProfileId);
});

test("a tutor starts on weekly, and an account still on the old daily schedule is moved to weekly once", async () => {
  const actor = await tutor();
  assert.equal((await profile(actor)).speed, "weekly");
  const accountId = await ensureConnectAccount(actor);
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "weekly");

  await fakeStripe.setPayoutSchedule(accountId, "daily");
  assert.deepEqual(await scheduleCalls(() => payoutsFor(actor)), [[accountId, "weekly"]]);
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "weekly");
  assert.deepEqual(await scheduleCalls(() => payoutsFor(actor)), []);
});

test("choosing daily sends daily to Stripe, and switching back sends weekly", async () => {
  const actor = await tutor();
  const accountId = await ensureConnectAccount(actor);

  const toDaily = await scheduleCalls(async () => assert.equal((await choosePayoutSpeed(actor, "daily")).speed, "daily"));
  assert.deepEqual(toDaily, [[accountId, "daily"]]);
  assert.equal((await profile(actor)).speed, "daily");
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "daily");

  assert.deepEqual(await scheduleCalls(() => choosePayoutSpeed(actor, "daily")), []);
  assert.deepEqual(await scheduleCalls(() => choosePayoutSpeed(actor, "weekly")), [[accountId, "weekly"]]);
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "weekly");
});

test("a speed chosen before payout setup reaches the account once it exists", async () => {
  const actor = await tutor();
  assert.deepEqual(await scheduleCalls(() => choosePayoutSpeed(actor, "daily")), []);
  const accountId = await ensureConnectAccount(actor);
  assert.deepEqual(await scheduleCalls(() => payoutsFor(actor)), [[accountId, "daily"]]);
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "daily");
});

test("account.updated puts back the stored speed, and a repeated event sends nothing", async () => {
  const actor = await tutor();
  const accountId = await ensureConnectAccount(actor);
  await choosePayoutSpeed(actor, "daily");
  await fakeStripe.setPayoutSchedule(accountId, null);
  const event = await fakeStripe.accountEvent(accountId);

  const calls = await scheduleCalls(async () => {
    assert.deepEqual(await deliver(event), { status: 200, outcome: "kyc_synced", institutionId: home });
    assert.deepEqual(await deliver(event), { status: 200, outcome: "kyc_synced", institutionId: home });
  });
  assert.deepEqual(calls, [[accountId, "daily"]]);
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "daily");
});

test("Stripe refusing the schedule change never blocks the KYC sync", async () => {
  const actor = await tutor();
  const accountId = await ensureConnectAccount(actor);
  await fakeStripe.setPayoutSchedule(accountId, "daily");
  await fakeStripe.setAccount(accountId, "verified");
  const real = stripeGateway().setPayoutSpeed;
  const error = console.error;
  stripeGateway().setPayoutSpeed = async () => {
    throw new GatewayError("This account cannot be updated", { status: 400, type: "invalid_request_error" });
  };
  console.error = () => {};
  try {
    assert.deepEqual(await deliver(await fakeStripe.accountEvent(accountId)), { status: 200, outcome: "kyc_synced", institutionId: home });
  } finally {
    stripeGateway().setPayoutSpeed = real;
    console.error = error;
  }
  assert.deepEqual(await profile(actor), { accountId, status: "verified", speed: "weekly" });
  assert.equal((await stripeGateway().retrieveAccount(accountId)).payoutSpeed, "daily");
});
