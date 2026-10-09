import assert from "node:assert/strict";
import { test } from "node:test";

import { moneyViolations, type MoneyFacts } from "./invariants";

type Totals = MoneyFacts["engagements"][number]["totals"];

const t = (minor: number, rows = 1) => ({ minor, rows });

const healthy: MoneyFacts = {
  engagements: [
    {
      id: "refunded-after-one",
      status: "completed",
      pricePaidMinor: 14_000,
      totals: { package_purchase: t(14_000), session_earned: t(3_500), tutor_payout: t(3_150), platform_fee: t(350), refund: t(10_500) },
    },
    { id: "untouched", status: "active", pricePaidMinor: 3_500, totals: { package_purchase: t(3_500) } },
  ],
  sessions: [{ id: "s1", totals: { session_earned: t(3_500), tutor_payout: t(3_150), platform_fee: t(350) } }],
  tutorTerms: [{ tutorProfileId: "tp", termId: "term", feeMinor: 10_000 }],
};

const invariants = (facts: MoneyFacts) => moneyViolations(facts).map((v) => v.invariant);

test("a consistent ledger has no violations", () => {
  assert.deepEqual(moneyViolations(healthy), []);
});

test("a missing, doubled or mispriced purchase is flagged", () => {
  for (const totals of [{}, { package_purchase: t(7_000, 2) }, { package_purchase: t(3_000) }] as Totals[]) {
    assert.deepEqual(
      invariants({ ...healthy, engagements: [{ id: "e", status: "active", pricePaidMinor: 3_500, totals }] }),
      ["one purchase of the price"],
    );
  }
});

test("refunding more than was paid breaks both the refund and deferred checks", () => {
  const e = { id: "e", status: "refunded" as const, pricePaidMinor: 3_500, totals: { package_purchase: t(3_500), refund: t(4_000) } };
  assert.deepEqual(invariants({ ...healthy, engagements: [e] }), ["refund <= purchase", "deferred >= 0", "deferred = 0 once closed"]);
});

test("a closed package with money left deferred is flagged, refunded or not", () => {
  for (const totals of [{ package_purchase: t(14_000), refund: t(7_000) }, { package_purchase: t(14_000) }] as Totals[]) {
    const e = { id: "e", status: "completed" as const, pricePaidMinor: 14_000, totals };
    assert.deepEqual(invariants({ ...healthy, engagements: [e] }), ["deferred = 0 once closed"]);
  }
});

test("a session recognised twice is flagged", () => {
  const sessions = [{ id: "s", totals: { session_earned: t(7_000, 2), tutor_payout: t(6_300, 2), platform_fee: t(700, 2) } }];
  assert.deepEqual(invariants({ ...healthy, sessions }), ["one recognition per session"]);
});

test("a fee above the take rate is flagged, and the floor is allowed", () => {
  const over = [{ id: "s", totals: { session_earned: t(3_500), tutor_payout: t(3_100), platform_fee: t(400) } }];
  assert.deepEqual(invariants({ ...healthy, sessions: over }), ["fee <= take rate"]);
  const floored = [{ id: "s", totals: { session_earned: t(3_155), tutor_payout: t(2_840), platform_fee: t(315) } }];
  assert.deepEqual(invariants({ ...healthy, sessions: floored }), []);
});

test("a session whose split does not add up to what was earned is flagged", () => {
  const sessions = [{ id: "s", totals: { session_earned: t(3_500), tutor_payout: t(2_730) } }];
  assert.deepEqual(invariants({ ...healthy, sessions }), ["earned = accrued + fee"]);
});

test("transfers net of reversals may not exceed what the tutor accrued", () => {
  const base = { id: "e", status: "active" as const, pricePaidMinor: 14_000 };
  const accrued = { package_purchase: t(14_000), session_earned: t(3_500), tutor_payout: t(3_150), platform_fee: t(350) };
  assert.deepEqual(invariants({ ...healthy, engagements: [{ ...base, totals: { ...accrued, tutor_transfer: t(3_150) } }] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [{ ...base, totals: { ...accrued, tutor_transfer: t(6_300, 2) } }] }), [
    "transferred <= accrued",
  ]);
  assert.deepEqual(
    invariants({ ...healthy, engagements: [{ ...base, totals: { ...accrued, tutor_transfer: t(6_300, 2), transfer_reversal: t(3_150) } }] }),
    [],
  );
});

test("a tutor's fees past the term cap are flagged", () => {
  assert.deepEqual(invariants({ ...healthy, tutorTerms: [{ tutorProfileId: "tp", termId: "term", feeMinor: 10_001 }] }), ["fee <= term cap"]);
});
