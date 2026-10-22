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
      totals: { package_purchase: t(14_000), session_earned: t(3_500), tutor_accrued: t(3_150), platform_fee: t(350), refund: t(10_500) },
    },
    { id: "untouched", status: "active", pricePaidMinor: 3_500, totals: { package_purchase: t(3_500) } },
  ],
  sessions: [{ id: "s1", tutorProfileId: "tp", totals: { session_earned: t(3_500), tutor_accrued: t(3_150), platform_fee: t(350) } }],
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

test("a pending or released checkout carries no purchase and nothing deferred", () => {
  for (const status of ["pending_payment", "cancelled"] as const) {
    assert.deepEqual(invariants({ ...healthy, engagements: [{ id: "e", status, pricePaidMinor: 14_000, totals: {} }] }), []);
    assert.deepEqual(
      invariants({ ...healthy, engagements: [{ id: "e", status, pricePaidMinor: 14_000, totals: { package_purchase: t(14_000) } }] }),
      status === "cancelled" ? ["no purchase while unpaid", "deferred = 0 once closed"] : ["no purchase while unpaid"],
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
  const sessions = [{ id: "s", tutorProfileId: "tp", totals: { session_earned: t(7_000, 2), tutor_accrued: t(6_300, 2), platform_fee: t(700, 2) } }];
  assert.deepEqual(invariants({ ...healthy, sessions }), ["one recognition per session"]);
});

test("a fee above the take rate is flagged, and the floor is allowed", () => {
  const over = [{ id: "s", tutorProfileId: "tp", totals: { session_earned: t(3_500), tutor_accrued: t(3_100), platform_fee: t(400) } }];
  assert.deepEqual(invariants({ ...healthy, sessions: over }), ["fee <= take rate"]);
  const floored = [{ id: "s", tutorProfileId: "tp", totals: { session_earned: t(3_155), tutor_accrued: t(2_840), platform_fee: t(315) } }];
  assert.deepEqual(invariants({ ...healthy, sessions: floored }), []);
});

const feeHistory = (sessionMinor: number, fees: number[]) =>
  fees.map((fee, i) => ({
    id: `s${i}`,
    tutorProfileId: "tp",
    totals: { session_earned: t(sessionMinor), tutor_accrued: t(sessionMinor - fee), platform_fee: t(fee) },
  }));
const times = (n: number, fee: number) => Array<number>(n).fill(fee);

test("a full take after $100 in fees is flagged, and the lower take is allowed", () => {
  assert.deepEqual(invariants({ ...healthy, sessions: feeHistory(5_000, [...times(20, 500), 250]) }), []);
  assert.deepEqual(invariants({ ...healthy, sessions: feeHistory(5_000, times(21, 500)) }), ["full take only below the fee milestone"]);
});

test("the session that crosses $100 may take more than 5%, and the one after may not", () => {
  assert.deepEqual(invariants({ ...healthy, sessions: feeHistory(3_500, [...times(28, 350), 275, 175]) }), []);
  assert.deepEqual(invariants({ ...healthy, sessions: feeHistory(3_500, [...times(28, 350), 275, 350]) }), [
    "full take only below the fee milestone",
  ]);
});

test("fees written under the term cap and the 10-session step still pass", () => {
  assert.deepEqual(invariants({ ...healthy, sessions: feeHistory(5_000, [...times(10, 500), ...times(20, 250), 0, 0]) }), []);
  assert.deepEqual(invariants({ ...healthy, sessions: feeHistory(3_500, [...times(10, 350), ...times(22, 175)]) }), []);
});

test("a session whose split does not add up to what was earned is flagged", () => {
  const sessions = [{ id: "s", tutorProfileId: "tp", totals: { session_earned: t(3_500), tutor_accrued: t(2_730) } }];
  assert.deepEqual(invariants({ ...healthy, sessions }), ["earned = accrued + fee"]);
});

test("transfers net of reversals may not exceed what the tutor accrued", () => {
  const base = { id: "e", status: "active" as const, pricePaidMinor: 14_000, references: { package_purchase: ["pi_1"] } };
  const accrued = { package_purchase: t(14_000), session_earned: t(3_500), tutor_accrued: t(3_150), platform_fee: t(350) };
  assert.deepEqual(invariants({ ...healthy, engagements: [{ ...base, totals: { ...accrued, tutor_transfer: t(3_150) } }] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [{ ...base, totals: { ...accrued, tutor_transfer: t(6_300, 2) } }] }), [
    "transferred <= accrued",
  ]);
  assert.deepEqual(
    invariants({ ...healthy, engagements: [{ ...base, totals: { ...accrued, tutor_transfer: t(6_300, 2), transfer_reversal: t(3_150) } }] }),
    [],
  );
});

test("an engagement may carry many refund rows while together they stay within the purchase and the deferred money", () => {
  const e = (status: "active" | "completed", totals: Totals) => ({ id: "e", status, pricePaidMinor: 14_000, totals: { package_purchase: t(14_000), ...totals } });
  const cancelsThenEnd = { session_earned: t(5_250, 2), refund: t(8_750, 3) };
  assert.deepEqual(invariants({ ...healthy, engagements: [e("completed", cancelsThenEnd)] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("active", { session_earned: t(2_625), refund: t(875) })] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("active", { refund: t(14_000, 2) })] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("active", { session_earned: t(3_500), refund: t(14_000, 2) })] }), ["deferred >= 0"]);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("active", { refund: t(14_001, 2) })] }), ["refund <= purchase", "deferred >= 0"]);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("completed", { session_earned: t(2_625), refund: t(875, 2) })] }), ["deferred = 0 once closed"]);
});

test("a refund row may carry only a Stripe refund or a manual settlement", () => {
  const e = (reference: string | null) => ({
    id: "e",
    status: "refunded" as const,
    pricePaidMinor: 14_000,
    totals: { package_purchase: t(14_000), refund: t(14_000) },
    references: { refund: [reference] },
  });
  for (const ok of [null, "re_123", "manual:abc"]) assert.deepEqual(invariants({ ...healthy, engagements: [e(ok)] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("pi_123")] }), ["refund reference is re_ or manual:"]);
});

test("transfer rows carry tr_, manual:, forfeited: or nothing yet, reversals carry trr_, and reversals never exceed transfers", () => {
  const e = (references: Record<string, (string | null)[]>, totals: Totals = {}) => ({
    id: "e",
    status: "active" as const,
    pricePaidMinor: 14_000,
    totals: { package_purchase: t(14_000), session_earned: t(3_500), tutor_accrued: t(3_150), platform_fee: t(350), tutor_transfer: t(3_150), ...totals },
    references: { package_purchase: ["pi_123"], ...references },
  });
  for (const ok of [null, "tr_123", "manual:abc", "forfeited:abc"]) {
    assert.deepEqual(invariants({ ...healthy, engagements: [e({ tutor_transfer: [ok] })] }), []);
  }
  assert.deepEqual(invariants({ ...healthy, engagements: [e({ tutor_transfer: ["re_123"] })] }), ["transfer reference is tr_, manual: or forfeited:"]);
  assert.deepEqual(
    invariants({ ...healthy, engagements: [e({ tutor_transfer: ["tr_1"], transfer_reversal: ["trr_1"] }, { transfer_reversal: t(1_000) })] }),
    [],
  );
  assert.deepEqual(
    invariants({ ...healthy, engagements: [e({ tutor_transfer: ["tr_1"], transfer_reversal: [null] }, { transfer_reversal: t(1_000) })] }),
    ["reversal reference is trr_"],
  );
  assert.deepEqual(
    invariants({ ...healthy, engagements: [e({ tutor_transfer: ["tr_1"], transfer_reversal: ["trr_1"] }, { transfer_reversal: t(4_000) })] }),
    ["reversals <= transfers"],
  );
});

test("a transfer on an engagement whose purchase never went through Stripe is flagged", () => {
  const e = (purchase: string | null) => ({
    id: "e",
    status: "active" as const,
    pricePaidMinor: 14_000,
    totals: { package_purchase: t(14_000), session_earned: t(3_500), tutor_accrued: t(3_150), platform_fee: t(350), tutor_transfer: t(3_150) },
    references: { package_purchase: [purchase], tutor_transfer: ["tr_1"] },
  });
  assert.deepEqual(invariants({ ...healthy, engagements: [e("pi_123")] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [e(null)] }), ["transfers only from a Stripe purchase"]);
  assert.deepEqual(invariants({ ...healthy, engagements: [e("pi_test_seeded")] }), []);
});

test("fixture references pass only between personas, and a fixture purchase pays out only fixture transfers", () => {
  const e = (betweenPersonas: boolean, references: Record<string, (string | null)[]>) => ({
    id: "e",
    status: "active" as const,
    pricePaidMinor: 14_000,
    betweenPersonas,
    totals: { package_purchase: t(14_000), session_earned: t(3_500), tutor_accrued: t(3_150), platform_fee: t(350), tutor_transfer: t(3_150) },
    references,
  });
  const fixture = { package_purchase: ["fixture_pi_1"], tutor_transfer: ["fixture_tr_1"] };
  assert.deepEqual(invariants({ ...healthy, engagements: [e(true, fixture)] }), []);
  assert.deepEqual(invariants({ ...healthy, engagements: [e(false, fixture)] }), [
    "fixture reference only between personas",
    "fixture reference only between personas",
  ]);
  assert.deepEqual(invariants({ ...healthy, engagements: [e(false, { package_purchase: ["pi_1"], tutor_transfer: ["fixture_tr_1"] })] }), [
    "fixture reference only between personas",
    "transfer reference is tr_, manual: or forfeited:",
  ]);
  assert.deepEqual(invariants({ ...healthy, engagements: [e(true, { package_purchase: ["pi_1"], tutor_transfer: ["fixture_tr_1"] })] }), [
    "transfer reference is tr_, manual: or forfeited:",
  ]);
  for (const transfer of ["tr_1", "manual:abc", null]) {
    assert.deepEqual(invariants({ ...healthy, engagements: [e(true, { package_purchase: ["fixture_pi_1"], tutor_transfer: [transfer] })] }), [
      "a fixture purchase pays out fixture_tr_",
    ]);
  }
});

test("an end fee is the tutor's whole and at most 10% of what was left", () => {
  const ended = (unattached: Totals, earned = 4_550, accrued = 4_200) => ({
    ...healthy,
    engagements: [
      {
        id: "ended",
        status: "completed" as const,
        pricePaidMinor: 14_000,
        totals: { package_purchase: t(14_000), session_earned: t(earned, 2), tutor_accrued: t(accrued, 2), platform_fee: t(350), refund: t(14_000 - earned) },
        unattached,
      },
    ],
  });
  assert.deepEqual(invariants(ended({ session_earned: t(1_050), tutor_accrued: t(1_050), refund: t(9_450) })), []);
  assert.deepEqual(
    invariants(ended({ session_earned: t(2_100), tutor_accrued: t(2_100), refund: t(8_400) }, 5_600, 5_250)),
    ["the end fee is at most 10% of what was left"],
  );
  assert.deepEqual(
    invariants(ended({ session_earned: t(1_050), tutor_accrued: t(945), platform_fee: t(105), refund: t(9_450) }, 4_550, 4_095)),
    ["pay without a session is only the end fee"],
  );
});

test("tutor pay naming no session is only the end fee, and a platform fee always names one", () => {
  const withLoose = (unattached: Totals) => ({
    ...healthy,
    engagements: [
      {
        id: "open",
        status: "active" as const,
        pricePaidMinor: 14_000,
        totals: { package_purchase: t(14_000), tutor_accrued: t(2_000), platform_fee: t(500) },
        unattached,
      },
    ],
  });
  assert.deepEqual(invariants(withLoose({ tutor_accrued: t(2_000) })), ["pay without a session is only the end fee"]);
  assert.deepEqual(invariants(withLoose({ platform_fee: t(500) })), ["pay without a session is only the end fee"]);
});
