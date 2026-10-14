import { deepStrictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import Stripe from "stripe";

import { GatewayError, errorFacts, stripeGateway, usingFakeStripe } from "../src/server/modules/billing/stripe";

const ACCOUNT_TAG = "stripe-smoke";
const CHARGE_MINOR = 14_000;
const FEE_MINOR = 436;
const REFUND_MINOR = 3_500;
const TRANSFER_MINOR = 7_000;

function check<T>(label: string, actual: T, expected: T): void {
  try {
    deepStrictEqual(actual, expected);
  } catch {
    throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`ok  ${label}`);
}

// The app charges cards and verifies accounts on Stripe's hosted pages, so the gateway has no call
// for either. Those two fixtures go to Stripe directly; every other call goes through the gateway.
async function smokeAccount(stripe: Stripe): Promise<string> {
  const gateway = stripeGateway();
  const tagged = (await gateway.listAccounts()).filter((account) => account.tutorProfileId === ACCOUNT_TAG);
  let id = tagged.find((account) => account.transfers === "active")?.id ?? tagged.at(0)?.id;
  if (id) {
    console.log(`ok  reusing the test account tagged ${ACCOUNT_TAG}`);
  } else {
    const account = await stripe.accounts.create({
      country: "US",
      controller: {
        stripe_dashboard: { type: "none" },
        fees: { payer: "application" },
        losses: { payments: "application" },
        requirement_collection: "application",
      },
      capabilities: { transfers: { requested: true } },
      business_type: "individual",
      business_profile: { mcc: "8299", url: "https://accessible.stripe.com" },
      individual: {
        first_name: "Smoke",
        last_name: "Test",
        email: "stripe-smoke@example.com",
        phone: "+10000000000",
        dob: { day: 1, month: 1, year: 1901 },
        ssn_last_4: "0000",
        id_number: "000000000",
        address: { line1: "address_full_match", city: "Tuscaloosa", state: "AL", postal_code: "35401", country: "US" },
      },
      external_account: {
        object: "bank_account",
        country: "US",
        currency: "usd",
        routing_number: "110000000",
        account_number: "000123456789",
      },
      tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
      metadata: { tutor_profile_id: ACCOUNT_TAG },
    });
    id = account.id;
    console.log(`ok  created a test account tagged ${ACCOUNT_TAG}`);
  }

  for (let attempt = 1; ; attempt++) {
    const account = await gateway.retrieveAccount(id);
    if (account.transfers === "active") return id;
    if (attempt === 12) {
      throw new Error(
        `The ${ACCOUNT_TAG} test account cannot receive transfers (transfers: ${account.transfers}, disabled: ${account.disabledReason}, past due: ${account.pastDue.join(", ") || "none"}). Delete it in the test Dashboard and the next run makes a new one.`,
      );
    }
    await sleep(5_000);
  }
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test-mode key (sk_test_).");
  if (usingFakeStripe()) throw new Error("STRIPE_FAKE is set; the smoke test exercises the real driver.");

  const stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 15_000 });
  const gateway = stripeGateway();
  const accountId = await smokeAccount(stripe);
  const runId = `smoke-${randomUUID()}`;
  const institutionId = ACCOUNT_TAG;

  const intent = await stripe.paymentIntents.create(
    {
      amount: CHARGE_MINOR,
      currency: "usd",
      payment_method: "pm_card_visa",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      confirm: true,
      transfer_group: runId,
      description: ACCOUNT_TAG,
      metadata: { engagement_id: runId },
    },
    { idempotencyKey: `${runId}:charge` },
  );
  check("PaymentIntent confirmed with pm_card_visa", intent.status, "succeeded");

  check("payment read back", await gateway.retrievePayment(intent.id), {
    id: intent.id,
    amountMinor: CHARGE_MINOR,
    refundedMinor: 0,
    currency: "usd",
  });
  let fee = await gateway.chargeFee(intent.id);
  for (let attempt = 1; !fee && attempt < 15; attempt++) {
    await sleep(2_000);
    fee = await gateway.chargeFee(intent.id);
  }
  check("processing fee is 2.9% + 30c", fee?.feeMinor, FEE_MINOR);
  const chargeId = await gateway.chargeOf(intent.id);
  check("charge id read back", chargeId?.startsWith("ch_"), true);

  const newRefund = {
    paymentIntentId: intent.id,
    engagementId: runId,
    institutionId,
    amountMinor: REFUND_MINOR,
    ledgerEntryId: `${runId}:refund`,
    idempotencyKey: `refund:${runId}`,
  };
  const refund = await gateway.refund(newRefund);
  check(
    "partial refund created",
    { status: refund.status, amountMinor: refund.amountMinor, paymentIntentId: refund.paymentIntentId, ledgerEntryId: refund.ledgerEntryId },
    { status: "succeeded", amountMinor: REFUND_MINOR, paymentIntentId: intent.id, ledgerEntryId: `${runId}:refund` },
  );
  check("refund retried on the same key returns the same refund", (await gateway.refund(newRefund)).id, refund.id);
  check(
    "refunds listed",
    (await gateway.listRefunds(intent.id)).map((r) => [r.id, r.amountMinor]),
    [[refund.id, REFUND_MINOR]],
  );
  check("payment shows the refund", (await gateway.retrievePayment(intent.id)).refundedMinor, REFUND_MINOR);

  const newTransfer = {
    accountId,
    chargeId: chargeId!,
    amountMinor: TRANSFER_MINOR,
    currency: "usd",
    engagementId: runId,
    institutionId,
    ledgerEntryId: `${runId}:transfer`,
    idempotencyKey: `transfer:${runId}`,
  };
  const transfer = await gateway.createTransfer(newTransfer);
  check(
    "transfer created from the charge",
    {
      amountMinor: transfer.amountMinor,
      destination: transfer.destination,
      sourceTransaction: transfer.sourceTransaction,
      transferGroup: transfer.transferGroup,
      ledgerEntryId: transfer.ledgerEntryId,
      reversedMinor: transfer.reversedMinor,
    },
    {
      amountMinor: TRANSFER_MINOR,
      destination: accountId,
      sourceTransaction: chargeId,
      transferGroup: runId,
      ledgerEntryId: `${runId}:transfer`,
      reversedMinor: 0,
    },
  );
  check("transfer retried on the same key returns the same transfer", (await gateway.createTransfer(newTransfer)).id, transfer.id);
  check(
    "transfers listed by group",
    (await gateway.listTransfers(runId)).map((t) => [t.id, t.amountMinor]),
    [[transfer.id, TRANSFER_MINOR]],
  );
  const read = await gateway.retrieveTransfer(transfer.id);
  check("transfer read back", [read.amountMinor, read.reversedMinor, read.reversals], [TRANSFER_MINOR, 0, []]);

  console.log("stripe smoke passed");
}

main().catch((error: unknown) => {
  if (error instanceof GatewayError) console.error(`gateway error ${errorFacts(error)}`);
  else if (error instanceof Stripe.errors.StripeError) {
    const { statusCode, code, type, requestId } = error;
    console.error(`stripe error ${JSON.stringify({ statusCode, code, type, requestId })}`);
  } else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
