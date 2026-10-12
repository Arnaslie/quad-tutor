import assert from "node:assert/strict";
import { test } from "node:test";

import { kycStatusOf, payoutStageOf } from "./kyc";

const fresh = {
  detailsSubmitted: false,
  payoutsEnabled: false,
  transfers: "inactive",
  disabledReason: "requirements.past_due",
  pastDue: ["external_account", "individual.dob.day"],
};
const verified = { detailsSubmitted: true, payoutsEnabled: true, transfers: "active", disabledReason: null, pastDue: [] };

test("no account, or one never submitted, is not started", () => {
  assert.equal(kycStatusOf(null), "not_started");
  assert.equal(kycStatusOf(fresh), "not_started");
});

test("submitted with transfers not yet active is pending, including while Stripe reviews", () => {
  assert.equal(kycStatusOf({ ...verified, transfers: "pending", payoutsEnabled: false }), "pending");
  assert.equal(kycStatusOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "requirements.pending_verification" }), "pending");
  assert.equal(kycStatusOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "under_review" }), "pending");
  assert.equal(kycStatusOf({ ...verified, payoutsEnabled: false }), "pending");
});

test("transfers active and payouts enabled is verified", () => {
  assert.equal(kycStatusOf(verified), "verified");
});

test("past-due requirements or a disabled reason restrict a submitted account", () => {
  assert.equal(kycStatusOf({ ...verified, pastDue: ["individual.verification.document"] }), "restricted");
  assert.equal(kycStatusOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "requirements.past_due", pastDue: ["external_account"] }), "restricted");
  assert.equal(kycStatusOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "rejected.fraud" }), "restricted");
  assert.equal(kycStatusOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "platform_paused" }), "restricted");
});

test("an unsubmitted account rejected or paused by Stripe is restricted, not merely unstarted", () => {
  assert.equal(kycStatusOf({ ...fresh, disabledReason: "rejected.terms_of_service" }), "restricted");
  assert.equal(kycStatusOf({ ...fresh, disabledReason: "platform_paused" }), "restricted");
});

test("a restriction Stripe imposed, not one the tutor can fill in, needs support", () => {
  assert.equal(payoutStageOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "rejected.fraud" }), "needs_support");
  assert.equal(payoutStageOf({ ...fresh, disabledReason: "rejected.terms_of_service" }), "needs_support");
  assert.equal(
    payoutStageOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "requirements.past_due", pastDue: ["external_account"] }),
    "restricted",
  );
  assert.equal(payoutStageOf({ ...verified, pastDue: ["individual.verification.document"] }), "restricted");
  assert.equal(
    payoutStageOf({ ...verified, transfers: "inactive", payoutsEnabled: false, disabledReason: "under_review", pastDue: ["individual.verification.document"] }),
    "restricted",
  );
  assert.equal(payoutStageOf(verified), "verified");
  assert.equal(payoutStageOf(null), "not_started");
});
