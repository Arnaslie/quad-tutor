import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import Stripe from "stripe";

import { API_VERSION, stripeDriver, type Gateway } from "./stripe";

type Sent = { method: string; path: string; body: URLSearchParams; idempotencyKey: string | null };

const sent: Sent[] = [];
let reply: Record<string, unknown> = {};
let server: Server;
let driver: Gateway;

function account(schedule: Record<string, unknown>) {
  return {
    id: "acct_local",
    object: "account",
    details_submitted: false,
    payouts_enabled: false,
    capabilities: { transfers: "inactive" },
    requirements: { disabled_reason: null, past_due: [] },
    settings: { payouts: { schedule: { delay_days: 2, ...schedule } } },
    metadata: {},
  };
}

before(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      sent.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: new URLSearchParams(body),
        idempotencyKey: (request.headers["idempotency-key"] as string | undefined) ?? null,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  driver = stripeDriver(
    new Stripe("sk_test_local", { apiVersion: API_VERSION, host: "127.0.0.1", port, protocol: "http", maxNetworkRetries: 0 }),
  );
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const scheduleOf = (body: URLSearchParams) =>
  Object.fromEntries([...body].filter(([key]) => key.startsWith("settings[payouts][schedule]")));

const WEEKLY = {
  "settings[payouts][schedule][interval]": "weekly",
  "settings[payouts][schedule][weekly_payout_days][0]": "friday",
};

test("a new Connect account is created to pay out weekly on Fridays", async () => {
  sent.length = 0;
  reply = account({ interval: "weekly", weekly_anchor: "friday" });
  const created = await driver.createAccount({ tutorProfileId: "tp_1", institutionId: "inst_1", email: "t@example.test" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, "/v1/accounts");
  assert.deepEqual(scheduleOf(sent[0].body), WEEKLY);
  assert.equal(sent[0].idempotencyKey, "connect-account:tp_1");
  assert.equal(created.payoutSpeed, "weekly");
});

test("setting a speed sends exactly that schedule to the account", async () => {
  sent.length = 0;
  reply = account({ interval: "daily" });
  const daily = await driver.setPayoutSpeed("acct_local", "daily");
  reply = account({ interval: "weekly", weekly_anchor: "friday", weekly_payout_days: ["friday"] });
  const weekly = await driver.setPayoutSpeed("acct_local", "weekly");

  assert.deepEqual(
    sent.map(({ method, path, body }) => [method, path, scheduleOf(body)]),
    [
      ["POST", "/v1/accounts/acct_local", { "settings[payouts][schedule][interval]": "daily" }],
      ["POST", "/v1/accounts/acct_local", WEEKLY],
    ],
  );
  assert.deepEqual([daily.payoutSpeed, weekly.payoutSpeed], ["daily", "weekly"]);
});

test("a schedule this app doesn't offer reads as no speed, so a sync replaces it", async () => {
  const speeds = [];
  for (const schedule of [
    { interval: "manual" },
    { interval: "monthly", monthly_anchor: 1 },
    { interval: "weekly", weekly_anchor: "monday" },
    { interval: "weekly", weekly_anchor: "friday", weekly_payout_days: ["monday", "friday"] },
    { interval: "weekly", weekly_payout_days: ["friday"] },
    { interval: "weekly", weekly_anchor: "friday", weekly_payout_days: [] },
  ]) {
    reply = account(schedule);
    speeds.push((await driver.retrieveAccount("acct_local")).payoutSpeed);
  }
  assert.deepEqual(speeds, [null, null, null, null, "weekly", "weekly"]);
});

test("an account paid out Mondays and Fridays is set to Fridays only, and then reads as weekly", async () => {
  sent.length = 0;
  reply = account({ interval: "weekly", weekly_anchor: "friday", weekly_payout_days: ["monday", "friday"] });
  assert.equal((await driver.retrieveAccount("acct_local")).payoutSpeed, null);
  reply = account({ interval: "weekly", weekly_anchor: "friday", weekly_payout_days: ["friday"] });
  assert.equal((await driver.setPayoutSpeed("acct_local", "weekly")).payoutSpeed, "weekly");

  assert.deepEqual(
    sent.map(({ method, path, body }) => [method, path, scheduleOf(body)]),
    [
      ["GET", "/v1/accounts/acct_local", {}],
      ["POST", "/v1/accounts/acct_local", WEEKLY],
    ],
  );
});
