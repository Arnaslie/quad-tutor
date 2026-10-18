import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import Stripe from "stripe";

import { API_VERSION, stripeDriver, type Gateway } from "./stripe";

type Sent = { method: string; path: string; body: URLSearchParams; idempotencyKey: string | null; account: string | null };

const sent: Sent[] = [];
let reply: Record<string, unknown> = {};
let routes: Record<string, unknown> = {};
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
        account: (request.headers["stripe-account"] as string | undefined) ?? null,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(routes[`${request.method} ${request.url?.split("?")[0]}`] ?? reply));
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
  "settings[payouts][schedule][weekly_anchor]": "friday",
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

function balance(instantAvailable: unknown[]) {
  return { object: "balance", available: [], pending: [], livemode: false, instant_available: instantAvailable };
}

function externals(...accounts: [string, string[]][]) {
  return {
    object: "list",
    url: "/v1/accounts/acct_local/external_accounts",
    has_more: false,
    data: accounts.map(([id, methods]) => ({ id, object: id.startsWith("card_") ? "card" : "bank_account", available_payout_methods: methods })),
  };
}

test("the instant balance is read as the tutor's account and counts only a destination that takes instant payouts", async () => {
  sent.length = 0;
  routes = {
    "GET /v1/balance": balance([
      { amount: 10_000, currency: "usd", net_available: [{ amount: 9_825, destination: "ba_slow" }, { amount: 9_825, destination: "card_fast" }] },
    ]),
    "GET /v1/accounts/acct_local/external_accounts": externals(["ba_slow", ["standard"]], ["card_fast", ["standard", "instant"]]),
  };
  assert.deepEqual(await driver.instantBalance("acct_local"), {
    grossMinor: 10_000,
    netMinor: 9_825,
    currency: "usd",
    destination: "card_fast",
  });
  const read = sent.find((request) => request.path.startsWith("/v1/balance"))!;
  assert.equal(read.account, "acct_local");
  assert.deepEqual([...new URL(read.path, "http://local").searchParams.values()], ["instant_available.net_available"]);
});

test("no instant balance without a platform fee, an instant destination, or Stripe's $0.50 minimum left after the fee", async () => {
  const card = externals(["card_fast", ["standard", "instant"]]);
  const quotes = [];
  for (const [pot, accounts] of [
    [{ amount: 10_000, currency: "usd" }, card],
    [{ amount: 10_000, currency: "usd", net_available: [{ amount: 10_000, destination: "card_fast" }] }, card],
    [{ amount: 10_000, currency: "usd", net_available: [{ amount: 9_825, destination: "ba_slow" }] }, externals(["ba_slow", ["standard"]])],
    [{ amount: 149, currency: "usd", net_available: [{ amount: 49, destination: "card_fast" }] }, card],
  ] as const) {
    routes = { "GET /v1/balance": balance([pot]), "GET /v1/accounts/acct_local/external_accounts": accounts };
    quotes.push(await driver.instantBalance("acct_local"));
  }
  assert.deepEqual(quotes, [null, null, null, null]);
});

test("an instant payout is created on the tutor's account with its key and campus", async () => {
  sent.length = 0;
  routes = {
    "POST /v1/payouts": { id: "po_local", object: "payout", amount: 9_825, currency: "usd", destination: "card_fast", status: "pending", method: "instant" },
  };
  const payout = await driver.createInstantPayout({
    accountId: "acct_local",
    amountMinor: 9_825,
    currency: "usd",
    destination: "card_fast",
    tutorProfileId: "tp_1",
    institutionId: "inst_1",
    idempotencyKey: "instant-payout:acct_local:req_1",
  });
  assert.deepEqual(
    sent.map(({ method, path, body, idempotencyKey, account }) => [method, path, Object.fromEntries(body), idempotencyKey, account]),
    [
      [
        "POST",
        "/v1/payouts",
        {
          amount: "9825",
          currency: "usd",
          method: "instant",
          destination: "card_fast",
          "metadata[tutor_profile_id]": "tp_1",
          "metadata[institution_id]": "inst_1",
        },
        "instant-payout:acct_local:req_1",
        "acct_local",
      ],
    ],
  );
  assert.deepEqual(payout, { id: "po_local", amountMinor: 9_825, currency: "usd", destination: "card_fast", status: "pending" });
});
