import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Stripe from "stripe";

import { INSTANT_FEE } from "./instant-fee";
import { DEFAULT_PAYOUT_SPEED, type PayoutSpeed } from "./payout-speed";

export const API_VERSION = "2026-09-30.endive";
const MIN_EXPIRY_SECONDS = 30 * 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const TUTOR_PRODUCT_DESCRIPTION = "Peer tutoring sessions for university courses, booked and paid through Quad Tutor.";

type ErrorFacts = {
  status?: number;
  code?: string;
  param?: string;
  type?: string;
  requestId?: string;
  idempotency?: boolean;
  replayed?: boolean;
};

export class GatewayError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly idempotency: boolean;
  /** Stripe answered from its idempotency cache rather than running the request. */
  readonly replayed: boolean;

  constructor(message: string, facts: ErrorFacts = {}, options?: ErrorOptions) {
    super(message, options);
    this.status = facts.status;
    this.code = facts.code;
    this.param = facts.param;
    this.type = facts.type;
    this.requestId = facts.requestId;
    this.idempotency = facts.idempotency ?? false;
    this.replayed = facts.replayed ?? false;
  }

  get missing(): boolean {
    return this.code === "resource_missing";
  }

  /** A card or charge refusal; asking again gets the same answer. Auth and lookup errors are not refusals. */
  get refused(): boolean {
    return (this.status === 400 || this.status === 402) && !this.idempotency;
  }

  get inFlight(): boolean {
    return this.status === 409;
  }
}

/** Stripe messages can echo request params such as customer_email, so logs carry only these facts. */
export function errorFacts(error: unknown): string {
  if (error instanceof GatewayError) {
    const { status, code, type, requestId } = error;
    return JSON.stringify({ status, code, type, requestId });
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export type NewCheckout = {
  engagementId: string;
  institutionId: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutSession = {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: string;
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string | null;
  engagementId: string | null;
  institutionId: string | null;
  successUrl: string | null;
};

export type ChargeFee = { feeMinor: number; balanceTransactionId: string } | null;

/** `amountMinor` is what the charge took, `refundedMinor` what its live refunds gave back. */
export type Payment = { id: string; amountMinor: number; refundedMinor: number; currency: string };

export type Refund = {
  id: string;
  status: string | null;
  amountMinor: number;
  currency: string;
  paymentIntentId: string | null;
  ledgerEntryId: string | null;
  engagementId: string | null;
  institutionId: string | null;
  failureReason: string | null;
};

export type NewRefund = {
  paymentIntentId: string;
  engagementId: string;
  institutionId: string;
  amountMinor?: number;
  ledgerEntryId?: string;
  idempotencyKey: string;
};

export type Transfer = {
  id: string;
  amountMinor: number;
  currency: string;
  destination: string | null;
  transferGroup: string | null;
  sourceTransaction: string | null;
  ledgerEntryId: string | null;
  engagementId: string | null;
  institutionId: string | null;
  /** A listed transfer carries only its first 10 reversals; `reversedMinor` is all of them. */
  reversals: { id: string; amountMinor: number }[];
  reversedMinor: number;
};

export type NewTransfer = {
  accountId: string;
  chargeId: string;
  amountMinor: number;
  currency: string;
  engagementId: string;
  institutionId: string;
  ledgerEntryId: string;
  idempotencyKey: string;
};

export type Dispute = {
  id: string;
  paymentIntentId: string | null;
  chargeId: string | null;
  amountMinor: number;
  currency: string;
  reason: string | null;
  status: string;
  createdAt: Date;
};

export type WebhookEvent = {
  id: string;
  type: string;
  livemode: boolean;
  account: string | null;
  objectId: string | null;
};

export type NewConnectAccount = { tutorProfileId: string; institutionId: string; email: string };

export type ConnectAccount = {
  id: string;
  detailsSubmitted: boolean;
  payoutsEnabled: boolean;
  transfers: string | null;
  disabledReason: string | null;
  pastDue: string[];
  /** Null when the account's payout schedule is not one this app offers, such as one set in a Dashboard. */
  payoutSpeed: PayoutSpeed | null;
  tutorProfileId: string | null;
  institutionId: string | null;
};

export type NewAccountLink = { accountId: string; refreshUrl: string; returnUrl: string };

/** What an instant payout to `destination` would take from the balance (`grossMinor`) and deliver (`netMinor`). */
export type InstantBalance = { grossMinor: number; netMinor: number; currency: string; destination: string };

export type NewInstantPayout = {
  accountId: string;
  amountMinor: number;
  currency: string;
  destination: string;
  tutorProfileId: string;
  institutionId: string;
  idempotencyKey: string;
};

export type InstantPayout = { id: string; amountMinor: number; currency: string; destination: string | null; status: string };

export type Gateway = {
  livemode: boolean;
  createCheckout(params: NewCheckout): Promise<CheckoutSession>;
  retrieveCheckout(id: string): Promise<CheckoutSession>;
  expireCheckout(id: string): Promise<CheckoutSession>;
  /** A paid Checkout Session for this engagement, found through its PaymentIntents' metadata. */
  findPaidCheckout(engagementId: string): Promise<CheckoutSession | null>;
  chargeFee(paymentIntentId: string): Promise<ChargeFee>;
  retrievePayment(paymentIntentId: string): Promise<Payment>;
  listRefunds(paymentIntentId: string): Promise<Refund[]>;
  chargeRefunds(chargeId: string): Promise<Refund[]>;
  retrieveRefund(id: string): Promise<Refund>;
  refund(params: NewRefund): Promise<Refund>;
  createAccount(params: NewConnectAccount): Promise<ConnectAccount>;
  retrieveAccount(id: string): Promise<ConnectAccount>;
  listAccounts(): Promise<ConnectAccount[]>;
  createAccountLink(params: NewAccountLink): Promise<string>;
  setPayoutSpeed(accountId: string, speed: PayoutSpeed): Promise<ConnectAccount>;
  /** Null unless an instant destination exists and the platform's fee is set, so net < gross. */
  instantBalance(accountId: string): Promise<InstantBalance | null>;
  createInstantPayout(params: NewInstantPayout): Promise<InstantPayout>;
  /** The PaymentIntent's `latest_charge`, which a transfer names as its `source_transaction`. */
  chargeOf(paymentIntentId: string): Promise<string | null>;
  createTransfer(params: NewTransfer): Promise<Transfer>;
  listTransfers(transferGroup: string): Promise<Transfer[]>;
  retrieveTransfer(id: string): Promise<Transfer>;
  retrieveDispute(id: string): Promise<Dispute>;
};

function ledgerMetadata(params: {
  engagementId: string | null;
  institutionId: string | null;
  ledgerEntryId?: string | null;
}): Record<string, string | null> {
  return {
    engagement_id: params.engagementId,
    institution_id: params.institutionId,
    ...(params.ledgerEntryId ? { ledger_entry_id: params.ledgerEntryId } : {}),
  };
}

function sessionView(session: Stripe.Checkout.Session): CheckoutSession {
  const paymentIntent = session.payment_intent;
  return {
    id: session.id,
    url: session.url,
    status: session.status === "complete" ? "complete" : session.status === "expired" ? "expired" : "open",
    paymentStatus: session.payment_status,
    paymentIntentId: typeof paymentIntent === "string" ? paymentIntent : (paymentIntent?.id ?? null),
    amountTotal: session.amount_total,
    currency: session.currency,
    engagementId: session.metadata?.engagement_id ?? null,
    institutionId: session.metadata?.institution_id ?? null,
    successUrl: session.success_url,
  };
}

const PAYOUT_SCHEDULES = {
  weekly: { interval: "weekly", weekly_anchor: "friday", weekly_payout_days: ["friday"] },
  daily: { interval: "daily" },
} satisfies Record<PayoutSpeed, Stripe.AccountUpdateParams.Settings.Payouts.Schedule>;

function speedOf(schedule: Stripe.Account.Settings.Payouts.Schedule | undefined): PayoutSpeed | null {
  if (schedule?.interval === "daily") return "daily";
  const days = schedule?.weekly_payout_days?.length ? schedule.weekly_payout_days : schedule?.weekly_anchor ? [schedule.weekly_anchor] : [];
  if (schedule?.interval === "weekly" && days.length === 1 && days[0] === "friday") return "weekly";
  return null;
}

function accountView(account: Stripe.Account): ConnectAccount {
  return {
    id: account.id,
    detailsSubmitted: account.details_submitted ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    transfers: account.capabilities?.transfers ?? null,
    disabledReason: account.requirements?.disabled_reason ?? null,
    pastDue: account.requirements?.past_due ?? [],
    payoutSpeed: speedOf(account.settings?.payouts?.schedule),
    tutorProfileId: account.metadata?.tutor_profile_id ?? null,
    institutionId: account.metadata?.institution_id ?? null,
  };
}

function refundView(refund: Stripe.Refund): Refund {
  const intent = refund.payment_intent;
  return {
    id: refund.id,
    status: refund.status,
    amountMinor: refund.amount,
    currency: refund.currency,
    paymentIntentId: typeof intent === "string" ? intent : (intent?.id ?? null),
    ledgerEntryId: refund.metadata?.ledger_entry_id ?? null,
    engagementId: refund.metadata?.engagement_id ?? null,
    institutionId: refund.metadata?.institution_id ?? null,
    failureReason: refund.failure_reason ?? null,
  };
}

const idOf = (value: string | { id: string } | null) => (typeof value === "string" ? value : (value?.id ?? null));

function transferView(transfer: Stripe.Transfer, reversals: Stripe.TransferReversal[]): Transfer {
  return {
    id: transfer.id,
    amountMinor: transfer.amount,
    currency: transfer.currency,
    destination: idOf(transfer.destination),
    transferGroup: transfer.transfer_group,
    sourceTransaction: idOf(transfer.source_transaction),
    ledgerEntryId: transfer.metadata?.ledger_entry_id ?? null,
    engagementId: transfer.metadata?.engagement_id ?? null,
    institutionId: transfer.metadata?.institution_id ?? null,
    reversals: reversals.map((r) => ({ id: r.id, amountMinor: r.amount })),
    reversedMinor: transfer.amount_reversed,
  };
}

function disputeView(dispute: Stripe.Dispute): Dispute {
  return {
    id: dispute.id,
    paymentIntentId: idOf(dispute.payment_intent),
    chargeId: idOf(dispute.charge),
    amountMinor: dispute.amount,
    currency: dispute.currency,
    reason: dispute.reason ?? null,
    status: dispute.status,
    createdAt: new Date(dispute.created * 1000),
  };
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof Stripe.errors.StripeError)) {
      throw new GatewayError(error instanceof Error ? error.message : String(error), {}, { cause: error });
    }
    throw new GatewayError(
      error.message,
      {
        status: error.statusCode,
        code: error.code,
        param: error.param,
        type: error.rawType ?? error.type,
        requestId: error.requestId,
        idempotency: error instanceof Stripe.errors.StripeIdempotencyError && error.statusCode === 400,
        replayed: error.headers?.["idempotent-replayed"] === "true",
      },
      { cause: error },
    );
  }
}

export const isLiveRefund = (refund: { status: string | null }) =>
  refund.status !== "failed" && refund.status !== "canceled";

function realGateway(): Gateway {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new GatewayError("STRIPE_SECRET_KEY is not set.");
  const livemode = key.startsWith("sk_live_");
  if (livemode) {
    throw new GatewayError(
      "Live Stripe keys are refused until refunds through Stripe and tutor transfers ship (Stripe plan items 4 and 6). Use an sk_test_ key.",
    );
  }
  return stripeDriver(new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 15_000 }), livemode);
}

export function stripeDriver(stripe: Stripe, livemode = false): Gateway {
  return {
    livemode,
    createCheckout: (params) =>
      call(async () => {
        const metadata = { engagement_id: params.engagementId, institution_id: params.institutionId };
        const session = await stripe.checkout.sessions.create(
          {
            mode: "payment",
            allowed_payment_method_types: ["card"],
            customer_email: params.customerEmail,
            expires_at: Math.floor(params.expiresAt.getTime() / 1000),
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: params.currency,
                  unit_amount: params.amountMinor,
                  product_data: { name: params.description },
                },
              },
            ],
            metadata,
            payment_intent_data: { metadata, transfer_group: params.engagementId },
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
          },
          { idempotencyKey: `checkout:${params.engagementId}` },
        );
        return sessionView(session);
      }),
    retrieveCheckout: (id) => call(async () => sessionView(await stripe.checkout.sessions.retrieve(id))),
    chargeOf: (paymentIntentId) => call(async () => idOf((await stripe.paymentIntents.retrieve(paymentIntentId)).latest_charge)),
    createTransfer: (params) =>
      call(async () => {
        const transfer = await stripe.transfers.create(
          {
            amount: params.amountMinor,
            currency: params.currency,
            destination: params.accountId,
            source_transaction: params.chargeId,
            transfer_group: params.engagementId,
            metadata: ledgerMetadata(params),
          },
          { idempotencyKey: params.idempotencyKey },
        );
        return transferView(transfer, transfer.reversals.data);
      }),
    listTransfers: (transferGroup) =>
      call(async () => {
        const transfers = await stripe.transfers.list({ transfer_group: transferGroup, limit: 100 });
        return transfers.data.map((t) => transferView(t, t.reversals.data));
      }),
    retrieveTransfer: (id) =>
      call(async () => {
        const transfer = await stripe.transfers.retrieve(id);
        const reversals = await stripe.transfers.listReversals(id, { limit: 100 }).autoPagingToArray({ limit: 10_000 });
        return transferView(transfer, reversals);
      }),
    retrieveDispute: (id) => call(async () => disputeView(await stripe.disputes.retrieve(id))),
    expireCheckout: (id) => call(async () => sessionView(await stripe.checkout.sessions.expire(id))),
    findPaidCheckout: (engagementId) =>
      call(async () => {
        const intents = await stripe.paymentIntents.search({
          query: `metadata['engagement_id']:'${engagementId}' AND status:'succeeded'`,
          limit: 10,
        });
        for (const intent of intents.data) {
          const sessions = await stripe.checkout.sessions.list({ payment_intent: intent.id, limit: 1 });
          const session = sessions.data.at(0);
          if (session) return sessionView(session);
        }
        return null;
      }),
    chargeFee: (paymentIntentId) =>
      call(async () => {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ["latest_charge.balance_transaction"],
        });
        const charge = intent.latest_charge;
        const transaction = typeof charge === "object" ? charge?.balance_transaction : null;
        if (!transaction || typeof transaction !== "object") return null;
        return { feeMinor: transaction.fee, balanceTransactionId: transaction.id };
      }),
    retrievePayment: (paymentIntentId) =>
      call(async () => {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
        const charge = typeof intent.latest_charge === "object" ? intent.latest_charge : null;
        return {
          id: intent.id,
          amountMinor: intent.amount_received,
          refundedMinor: charge?.amount_refunded ?? 0,
          currency: intent.currency,
        };
      }),
    listRefunds: (paymentIntentId) =>
      call(async () => {
        const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
        return refunds.data.map(refundView);
      }),
    chargeRefunds: (chargeId) =>
      call(async () => {
        const refunds = await stripe.refunds.list({ charge: chargeId, limit: 100 });
        return refunds.data.map(refundView);
      }),
    retrieveRefund: (id) => call(async () => refundView(await stripe.refunds.retrieve(id))),
    refund: (params) =>
      call(async () => {
        const refund = await stripe.refunds.create(
          {
            payment_intent: params.paymentIntentId,
            amount: params.amountMinor,
            metadata: ledgerMetadata(params),
          },
          { idempotencyKey: params.idempotencyKey },
        );
        return refundView(refund);
      }),
    createAccount: (params) =>
      call(async () => {
        const account = await stripe.accounts.create(
          {
            type: "express",
            country: "US",
            email: params.email,
            business_type: "individual",
            capabilities: { transfers: { requested: true } },
            business_profile: { product_description: TUTOR_PRODUCT_DESCRIPTION },
            settings: { payouts: { schedule: PAYOUT_SCHEDULES[DEFAULT_PAYOUT_SPEED] } },
            metadata: { tutor_profile_id: params.tutorProfileId, institution_id: params.institutionId },
          },
          { idempotencyKey: `connect-account:${params.tutorProfileId}` },
        );
        return accountView(account);
      }),
    retrieveAccount: (id) => call(async () => accountView(await stripe.accounts.retrieve(id))),
    listAccounts: () =>
      call(async () => (await stripe.accounts.list({ limit: 100 }).autoPagingToArray({ limit: 10_000 })).map(accountView)),
    createAccountLink: (params) =>
      call(async () => {
        const link = await stripe.accountLinks.create({
          account: params.accountId,
          type: "account_onboarding",
          collection_options: { fields: "eventually_due" },
          refresh_url: params.refreshUrl,
          return_url: params.returnUrl,
        });
        return link.url;
      }),
    /** No fixed idempotency key: a key per speed would replay a stale answer after a switch back within 24 hours. */
    setPayoutSpeed: (accountId, speed) =>
      call(async () =>
        accountView(await stripe.accounts.update(accountId, { settings: { payouts: { schedule: PAYOUT_SCHEDULES[speed] } } })),
      ),
    instantBalance: (accountId) =>
      call(async () => {
        const [balance, externals] = await Promise.all([
          stripe.balance.retrieve({ expand: ["instant_available.net_available"] }, { stripeAccount: accountId }),
          stripe.accounts.listExternalAccounts(accountId, { limit: 100 }),
        ]);
        const instant = new Set(
          externals.data.filter((external) => external.available_payout_methods?.includes("instant")).map((external) => external.id),
        );
        for (const pot of balance.instant_available ?? []) {
          const net = pot.net_available?.find((entry) => instant.has(entry.destination) && entry.amount > 0);
          if (net && net.amount < pot.amount) {
            return { grossMinor: pot.amount, netMinor: net.amount, currency: pot.currency, destination: net.destination };
          }
        }
        return null;
      }),
    createInstantPayout: (params) =>
      call(async () => {
        const payout = await stripe.payouts.create(
          {
            amount: params.amountMinor,
            currency: params.currency,
            method: "instant",
            destination: params.destination,
            metadata: { tutor_profile_id: params.tutorProfileId, institution_id: params.institutionId },
          },
          { stripeAccount: params.accountId, idempotencyKey: params.idempotencyKey },
        );
        return {
          id: payout.id,
          amountMinor: payout.amount,
          currency: payout.currency,
          destination: idOf(payout.destination),
          status: payout.status,
        };
      }),
  };
}

type FakeRecord = {
  session: CheckoutSession;
  expiresAt: number;
  params: NewCheckout;
  refunds: Refund[];
};

/** One folder per database, so worktrees running side by side never see each other's fake objects. */
function fakeDir(): string {
  const url = process.env.DATABASE_URL;
  const database = url ? new URL(url).pathname.slice(1).replace(/[^\w-]/g, "_") : "";
  return path.join(tmpdir(), "quad-tutor-stripe-fake", database || "default");
}
const fakeFile = (name: string) => path.join(fakeDir(), `${name.replace(/[^\w-]/g, "_")}.json`);

/** Objects a test has hidden answer `resource_missing`, as they would to a key for another account. */
const fakeHidden = new Set<string>();

async function fakeRead<T>(name: string): Promise<T | null> {
  if (fakeHidden.has(name)) return null;
  try {
    return JSON.parse(await readFile(fakeFile(name), "utf8")) as T;
  } catch {
    return null;
  }
}

async function fakeWrite(name: string, value: unknown): Promise<void> {
  await mkdir(fakeDir(), { recursive: true });
  const temp = `${fakeFile(name)}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, fakeFile(name));
}

const fakeLocks = new Map<string, Promise<unknown>>();

function locked<T>(name: string, work: () => Promise<T>): Promise<T> {
  const previous = fakeLocks.get(name) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  fakeLocks.set(name, next);
  void next.finally(() => {
    if (fakeLocks.get(name) === next) fakeLocks.delete(name);
  }).catch(() => undefined);
  return next;
}

const missing = (object: string, id: string) =>
  new GatewayError(`No such ${object}: '${id}'`, { status: 404, code: "resource_missing" });

async function fakeRecord(id: string): Promise<FakeRecord> {
  const record = await fakeRead<FakeRecord>(id);
  if (!record) throw missing("checkout.session", id);
  if (record.session.status === "open" && record.expiresAt * 1000 <= Date.now()) {
    record.session = { ...record.session, status: "expired", url: null };
    await fakeWrite(id, record);
  }
  return record;
}

const publicView = ({ session }: FakeRecord): CheckoutSession => session;

function assertNotProduction(): void {
  if (process.env.VERCEL_ENV === "production") {
    throw new GatewayError("The fake Stripe driver is refused in production.");
  }
}

const fakeGateway: Gateway = {
  livemode: false,
  createCheckout(params) {
    const key = `idem-checkout:${params.engagementId}`;
    return locked(key, async () => {
      const replay = await fakeRead<{ sessionId: string; params: string; at: number }>(key);
      const sent = JSON.stringify(params);
      if (replay && Date.now() - replay.at < IDEMPOTENCY_TTL_MS) {
        if (replay.params !== sent) {
          throw new GatewayError(
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
            { status: 400, idempotency: true },
          );
        }
        return publicView(await fakeRecord(replay.sessionId));
      }
      const expiresAt = Math.floor(params.expiresAt.getTime() / 1000);
      const now = Math.floor(Date.now() / 1000);
      if (expiresAt < now + MIN_EXPIRY_SECONDS || expiresAt > now + MAX_EXPIRY_SECONDS) {
        throw new GatewayError("expires_at must be between 30 minutes and 24 hours from now.", {
          status: 400,
          code: "parameter_invalid_integer",
          param: "expires_at",
        });
      }
      const id = `cs_fake_${randomUUID().replaceAll("-", "")}`;
      const record: FakeRecord = {
        session: {
          id,
          url: `${new URL(params.successUrl).origin}/api/dev/checkout/${id}`,
          status: "open",
          paymentStatus: "unpaid",
          paymentIntentId: null,
          amountTotal: params.amountMinor,
          currency: params.currency,
          engagementId: params.engagementId,
          institutionId: params.institutionId,
          successUrl: params.successUrl,
        },
        expiresAt,
        params,
        refunds: [],
      };
      await fakeWrite(id, record);
      await fakeWrite(key, { sessionId: id, params: sent, at: Date.now() });
      return publicView(record);
    });
  },
  async retrieveCheckout(id) {
    return publicView(await fakeRecord(id));
  },
  expireCheckout(id) {
    return locked(id, async () => {
      const record = await fakeRecord(id);
      if (record.session.status !== "open") {
        throw new GatewayError(
          `Only Checkout Sessions with a status in ["open"] can be expired: '${id}' is ${record.session.status}.`,
          { status: 400, code: "checkout_session_not_open" },
        );
      }
      record.session = { ...record.session, status: "expired", url: null };
      await fakeWrite(id, record);
      return publicView(record);
    });
  },
  async findPaidCheckout(engagementId) {
    const paid = await fakeRead<string[]>(`paid-${engagementId}`);
    for (const sessionId of paid ?? []) {
      const record = await fakeRead<FakeRecord>(sessionId);
      if (record?.session.status === "complete") return publicView(record);
    }
    return null;
  },
  async chargeFee(paymentIntentId) {
    const payment = await fakeRead<FakePayment>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    return {
      feeMinor: Math.round((payment.amountMinor * 29) / 1000) + 30,
      balanceTransactionId: `txn_${paymentIntentId}`,
    };
  },
  async retrievePayment(paymentIntentId) {
    const payment = await fakeRead<FakePayment>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    const { session, refunds } = await fakeRecord(payment.sessionId);
    return {
      id: paymentIntentId,
      amountMinor: payment.amountMinor,
      refundedMinor: refunds.filter(isLiveRefund).reduce((sum, r) => sum + r.amountMinor, 0),
      currency: session.currency ?? "usd",
    };
  },
  async listRefunds(paymentIntentId) {
    const payment = await fakeRead<FakePayment>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    return (await fakeRecord(payment.sessionId)).refunds;
  },
  chargeRefunds(chargeId) {
    return fakeGateway.listRefunds(chargeId.replace(/^ch_/, "pi_"));
  },
  async retrieveRefund(id) {
    const { refund } = await fakeRefund(id);
    return refund;
  },
  async refund(params) {
    const key = `idem-refund:${params.idempotencyKey}`;
    if (fakeRefundsInFlight.has(key)) {
      throw new GatewayError("There is currently another in-progress request using this Idempotent Key.", {
        status: 409,
        code: "idempotency_key_in_use",
      });
    }
    fakeRefundsInFlight.add(key);
    try {
      fakeRefundHold.reached();
      await fakeRefundHold.gate;
      return await fakeCreateRefund(key, params);
    } finally {
      fakeRefundsInFlight.delete(key);
    }
  },
  createAccount(params) {
    const key = `idem-connect-account:${params.tutorProfileId}`;
    return locked(key, async () => {
      const replay = await fakeRead<{ accountId: string; at: number }>(key);
      if (replay && Date.now() - replay.at < IDEMPOTENCY_TTL_MS) return fakeAccount(replay.accountId);
      const account: ConnectAccount = {
        id: `acct_fake_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        detailsSubmitted: false,
        payoutsEnabled: false,
        transfers: "inactive",
        disabledReason: "requirements.past_due",
        pastDue: ["external_account", "individual.dob.day", "individual.ssn_last_4", "tos_acceptance.date"],
        payoutSpeed: DEFAULT_PAYOUT_SPEED,
        tutorProfileId: params.tutorProfileId,
        institutionId: params.institutionId,
      };
      await fakeWrite(account.id, account);
      await fakeWrite(key, { accountId: account.id, at: Date.now() });
      return account;
    });
  },
  retrieveAccount: (id) => fakeAccount(id),
  async listAccounts() {
    const files = await readdir(fakeDir()).catch(() => []);
    const ids = files.filter((file) => file.startsWith("acct_fake_")).map((file) => file.replace(/\.json$/, ""));
    const accounts = await Promise.all(ids.map((id) => fakeRead<ConnectAccount>(id)));
    return accounts.filter((account): account is ConnectAccount => account !== null);
  },
  async createAccountLink(params) {
    await fakeAccount(params.accountId);
    const id = `acctlink_fake_${randomUUID().replaceAll("-", "")}`;
    await fakeWrite(id, params);
    return `${new URL(params.returnUrl).origin}/api/dev/connect/${id}`;
  },
  setPayoutSpeed: (accountId, speed) => fakeSchedule(accountId, speed),
  async instantBalance(accountId) {
    await fakeAccount(accountId);
    const destination = await fakeRead<string>(`debit-card-${accountId}`);
    const grossMinor = (await fakeRead<number>(`balance-${accountId}`)) ?? 0;
    const feeMinor = Math.min(
      INSTANT_FEE.maxMinor,
      Math.max(INSTANT_FEE.minMinor, Math.round((grossMinor * INSTANT_FEE.basisPoints) / 10_000)),
    );
    if (!destination || grossMinor - feeMinor <= 0) return null;
    return { grossMinor, netMinor: grossMinor - feeMinor, currency: "usd", destination };
  },
  createInstantPayout(params) {
    const key = `idem-instant-payout:${params.idempotencyKey}`;
    return locked(key, async () => {
      const sent = JSON.stringify({ ...params, idempotencyKey: undefined });
      const replay = await fakeRead<{ payout: InstantPayout; params: string; at: number }>(key);
      if (replay && Date.now() - replay.at < IDEMPOTENCY_TTL_MS) {
        if (replay.params !== sent) {
          throw new GatewayError(
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
            { status: 400, idempotency: true },
          );
        }
        return replay.payout;
      }
      return locked(`balance-${params.accountId}`, async () => {
        const offer = await fakeGateway.instantBalance(params.accountId);
        if (!offer || offer.destination !== params.destination || params.amountMinor !== offer.netMinor) {
          throw new GatewayError("You have insufficient funds in your Stripe account for this transfer.", {
            status: 400,
            code: "balance_insufficient",
          });
        }
        const payout: InstantPayout = {
          id: `po_fake_${randomUUID().replaceAll("-", "")}`,
          amountMinor: params.amountMinor,
          currency: params.currency,
          destination: params.destination,
          status: "in_transit",
        };
        await fakeWrite(`balance-${params.accountId}`, 0);
        await fakeWrite(key, { payout, params: sent, at: Date.now() });
        return payout;
      });
    });
  },
  async chargeOf(paymentIntentId) {
    if (!(await fakeRead<FakePayment>(paymentIntentId))) throw missing("payment_intent", paymentIntentId);
    return paymentIntentId.replace(/^pi_/, "ch_");
  },
  async createTransfer(params) {
    const transfer = await fakeCreateTransfer(params);
    if (fakeTransferLostResponses > 0) {
      fakeTransferLostResponses -= 1;
      throw new GatewayError("socket hang up");
    }
    return transfer;
  },
  async listTransfers(transferGroup) {
    const ids = (await fakeRead<string[]>(`transfer-group-${transferGroup}`)) ?? [];
    const transfers = await Promise.all(ids.map(fakeTransfer));
    return transfers.map((transfer) => ({ ...transfer, reversals: transfer.reversals.slice(0, 10) }));
  },
  retrieveTransfer: (id) => fakeTransfer(id),
  async retrieveDispute(id) {
    const dispute = await fakeRead<Dispute>(id);
    if (!dispute) throw missing("dispute", id);
    return { ...dispute, createdAt: new Date(dispute.createdAt) };
  },
};

async function fakeTransfer(id: string): Promise<Transfer> {
  const transfer = await fakeRead<Transfer>(id);
  if (!transfer) throw missing("transfer", id);
  return { ...transfer, reversedMinor: transfer.reversals.reduce((sum, r) => sum + r.amountMinor, 0) };
}

type FakeTransferReplay = {
  transfer: Transfer | null;
  error: (ErrorFacts & { message: string }) | null;
  params: string;
  at: number;
};

let fakeTransferOutages = 0;
let fakeTransferLostResponses = 0;

function fakeCreateTransfer(params: NewTransfer): Promise<Transfer> {
  const key = `idem-transfer:${params.idempotencyKey}`;
  return locked(key, async () => {
    const sent = JSON.stringify({ ...params, idempotencyKey: undefined });
    const replay = await fakeRead<FakeTransferReplay>(key);
    if (replay && Date.now() - replay.at < IDEMPOTENCY_TTL_MS) {
      if (replay.params !== sent) {
        throw new GatewayError(
          "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          { status: 400, idempotency: true },
        );
      }
      if (replay.error) throw new GatewayError(replay.error.message, { ...replay.error, replayed: true });
      return replay.transfer!;
    }

    return locked(params.chargeId, async () => {
      const refuse = async (error: ErrorFacts & { message: string }) => {
        await fakeWrite(key, { transfer: null, error, params: sent, at: Date.now() });
        throw new GatewayError(error.message, error);
      };
      if (fakeTransferOutages > 0) {
        fakeTransferOutages -= 1;
        return refuse({ message: "An unknown error occurred", status: 500, type: "api_error" });
      }
      const account = await fakeRead<ConnectAccount>(params.accountId);
      if (!account) throw missing("account", params.accountId);
      if (account.transfers !== "active") {
        return refuse({
          message: "Your destination account needs to have at least one of the following capabilities enabled: transfers.",
          status: 400,
          code: "insufficient_capabilities_for_transfer",
        });
      }
      const paymentIntentId = params.chargeId.replace(/^ch_/, "pi_");
      const payment = await fakeRead<FakePayment>(paymentIntentId);
      if (!payment) throw missing("charge", params.chargeId);
      const record = await fakeRecord(payment.sessionId);
      if (params.currency !== record.session.currency) {
        return refuse({ message: `The currency of source_transaction's balance transaction must match ${params.currency}.`, status: 400 });
      }
      const onCharge = (await fakeRead<string[]>(`transfer-charge-${params.chargeId}`)) ?? [];
      const sentBefore = (await Promise.all(onCharge.map(fakeTransfer))).reduce((sum, t) => sum + t.amountMinor, 0);
      if (sentBefore + params.amountMinor > payment.amountMinor) {
        return refuse({
          message: `Transfers using source_transaction ${params.chargeId} may not exceed its amount (${payment.amountMinor}).`,
          status: 400,
          code: "amount_too_large",
        });
      }

      const transfer: Transfer = {
        id: `tr_fake_${randomUUID().replaceAll("-", "")}`,
        amountMinor: params.amountMinor,
        currency: params.currency,
        destination: params.accountId,
        transferGroup: params.engagementId,
        sourceTransaction: params.chargeId,
        ledgerEntryId: params.ledgerEntryId,
        engagementId: params.engagementId,
        institutionId: params.institutionId,
        reversals: [],
        reversedMinor: 0,
      };
      const group = (await fakeRead<string[]>(`transfer-group-${params.engagementId}`)) ?? [];
      await fakeWrite(transfer.id, transfer);
      await fakeCredit(params.accountId, params.amountMinor);
      await fakeWrite(`transfer-charge-${params.chargeId}`, [...onCharge, transfer.id]);
      await fakeWrite(`transfer-group-${params.engagementId}`, [...group, transfer.id]);
      await fakeWrite(key, { transfer, error: null, params: sent, at: Date.now() });
      return transfer;
    });
  });
}

function signedEvent(type: string, object: Record<string, unknown>): { payload: string; signature: string } {
  const payload = JSON.stringify({
    id: `evt_fake_${randomUUID().replaceAll("-", "")}`,
    object: "event",
    api_version: API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type,
    data: { object },
  });
  return { payload, signature: signWebhookPayload(payload) };
}

async function fakeAccount(id: string): Promise<ConnectAccount> {
  const account = await fakeRead<ConnectAccount>(id);
  if (!account) throw missing("account", id);
  return { ...account, payoutSpeed: account.payoutSpeed ?? null };
}

function fakeCredit(accountId: string, deltaMinor: number): Promise<void> {
  const name = `balance-${accountId}`;
  return locked(name, async () => fakeWrite(name, ((await fakeRead<number>(name)) ?? 0) + deltaMinor));
}

function fakeSchedule(id: string, payoutSpeed: PayoutSpeed | null): Promise<ConnectAccount> {
  return locked(id, async () => {
    const account = { ...(await fakeAccount(id)), payoutSpeed };
    await fakeWrite(id, account);
    return account;
  });
}

const FAKE_ACCOUNT_STATES = {
  verified: { detailsSubmitted: true, payoutsEnabled: true, transfers: "active", disabledReason: null, pastDue: [] },
  pending: {
    detailsSubmitted: true,
    payoutsEnabled: false,
    transfers: "pending",
    disabledReason: "requirements.pending_verification",
    pastDue: [],
  },
  restricted: {
    detailsSubmitted: true,
    payoutsEnabled: false,
    transfers: "inactive",
    disabledReason: "requirements.past_due",
    pastDue: ["individual.verification.document"],
  },
  rejected: { detailsSubmitted: true, payoutsEnabled: false, transfers: "inactive", disabledReason: "rejected.other", pastDue: [] },
} satisfies Record<string, Partial<ConnectAccount>>;

function fakeCreateRefund(key: string, params: NewRefund): Promise<Refund> {
  return locked(key, async () => {
    const sent = JSON.stringify({ ...params, idempotencyKey: undefined });
    const replay = await fakeRead<FakeRefundReplay>(key);
    if (replay && Date.now() - replay.at < IDEMPOTENCY_TTL_MS) {
      if (replay.params !== sent) {
        throw new GatewayError(
          "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          { status: 400, idempotency: true },
        );
      }
      if (replay.error) throw new GatewayError(replay.error.message, { ...replay.error, replayed: true });
      return replay.refund!;
    }

    const payment = await fakeRead<FakePayment>(params.paymentIntentId);
    if (!payment) throw missing("payment_intent", params.paymentIntentId);
    return locked(payment.sessionId, async () => {
      const remember = (outcome: Pick<FakeRefundReplay, "refund" | "error">) =>
        fakeWrite(key, { ...outcome, params: sent, at: Date.now() });

      if (fakeRefundOutages > 0) {
        fakeRefundOutages -= 1;
        const error = { message: "An unknown error occurred", status: 500, type: "api_error" };
        await remember({ refund: null, error });
        throw new GatewayError(error.message, error);
      }
      const record = await fakeRecord(payment.sessionId);
      const left = payment.amountMinor - record.refunds.filter(isLiveRefund).reduce((sum, r) => sum + r.amountMinor, 0);
      const amountMinor = params.amountMinor ?? left;
      if (left <= 0 || amountMinor <= 0 || amountMinor > left) {
        const error = {
          message: `Refund amount (${amountMinor}) is greater than the unrefunded amount on the charge (${left}).`,
          status: 400,
          code: left <= 0 ? "charge_already_refunded" : "amount_too_large",
        };
        await remember({ refund: null, error });
        throw new GatewayError(error.message, error);
      }
      const refund: Refund = {
        id: `re_fake_${randomUUID().replaceAll("-", "")}`,
        status: "succeeded",
        amountMinor,
        currency: record.session.currency ?? "usd",
        paymentIntentId: params.paymentIntentId,
        ledgerEntryId: params.ledgerEntryId ?? null,
        engagementId: params.engagementId,
        institutionId: params.institutionId,
        failureReason: null,
      };
      record.refunds.push(refund);
      await fakeWrite(payment.sessionId, record);
      await fakeWrite(refund.id, { sessionId: payment.sessionId });
      await remember({ refund, error: null });
      return refund;
    });
  });
}

type FakePayment = { sessionId: string; amountMinor: number };
type FakeRefundReplay = {
  refund: Refund | null;
  error: (ErrorFacts & { message: string }) | null;
  params: string;
  at: number;
};

let fakeRefundOutages = 0;
const fakeRefundsInFlight = new Set<string>();
const UNHELD = { gate: Promise.resolve(), reached: () => {} };
let fakeRefundHold = UNHELD;

async function fakeRefund(id: string): Promise<{ sessionId: string; record: FakeRecord; refund: Refund }> {
  const owner = await fakeRead<{ sessionId: string }>(id);
  const record = owner ? await fakeRecord(owner.sessionId) : null;
  const refund = record?.refunds.find((r) => r.id === id);
  if (!owner || !record || !refund) throw missing("refund", id);
  return { sessionId: owner.sessionId, record, refund };
}

export const fakeStripe = {
  /** Plays the student paying on the hosted page; `amountTotal`/`currency` let tests fake a mismatch. */
  pay(id: string, paid: { amountTotal?: number; currency?: string } = {}): Promise<CheckoutSession> {
    assertNotProduction();
    return locked(id, async () => {
      const record = await fakeRecord(id);
      if (record.session.status !== "open") {
        throw new GatewayError(`This Checkout Session is ${record.session.status}.`, { status: 400 });
      }
      const paymentIntentId = `pi_fake_${randomUUID().replaceAll("-", "")}`;
      record.session = {
        ...record.session,
        status: "complete",
        paymentStatus: "paid",
        paymentIntentId,
        url: null,
        amountTotal: paid.amountTotal ?? record.session.amountTotal,
        currency: paid.currency ?? record.session.currency,
      };
      await fakeWrite(id, record);
      await fakeWrite(paymentIntentId, { sessionId: id, amountMinor: record.session.amountTotal });
      const engagementId = record.params.engagementId;
      const paidBefore = (await fakeRead<string[]>(`paid-${engagementId}`)) ?? [];
      await fakeWrite(`paid-${engagementId}`, [...paidBefore, id]);
      return publicView(record);
    });
  },
  async refunds(id: string): Promise<Refund[]> {
    return (await fakeRecord(id)).refunds;
  },
  async accountLink(id: string): Promise<NewAccountLink> {
    const link = await fakeRead<NewAccountLink>(id);
    if (!link) throw missing("account_link", id);
    return link;
  },
  /** Fake onboarding is instant: finishing the hosted form verifies the account. */
  setAccount(id: string, state: keyof typeof FAKE_ACCOUNT_STATES): Promise<ConnectAccount> {
    assertNotProduction();
    return locked(id, async () => {
      const account = { ...(await fakeAccount(id)), ...FAKE_ACCOUNT_STATES[state] };
      await fakeWrite(id, account);
      return account;
    });
  },
  /** Plays someone changing the schedule in a Dashboard; null is one this app doesn't offer, such as manual. */
  setPayoutSchedule(id: string, speed: PayoutSpeed | null): Promise<ConnectAccount> {
    assertNotProduction();
    return fakeSchedule(id, speed);
  },
  /** Plays the tutor adding a debit card that takes instant payouts. */
  async addDebitCard(id: string): Promise<string> {
    assertNotProduction();
    await fakeAccount(id);
    const card = `card_fake_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await fakeWrite(`debit-card-${id}`, card);
    return card;
  },
  /** A signed Connect `account.updated`; `object` lets tests send a stale payload. */
  async accountEvent(id: string, object?: ConnectAccount): Promise<{ payload: string; signature: string }> {
    assertNotProduction();
    const account = object ?? (await fakeAccount(id));
    const payload = JSON.stringify({
      id: `evt_fake_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      api_version: API_VERSION,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      account: id,
      type: "account.updated",
      data: {
        object: {
          id,
          object: "account",
          details_submitted: account.detailsSubmitted,
          payouts_enabled: account.payoutsEnabled,
          capabilities: { transfers: account.transfers },
          requirements: { disabled_reason: account.disabledReason, past_due: account.pastDue },
          metadata: { tutor_profile_id: account.tutorProfileId, institution_id: account.institutionId },
        },
      },
    });
    const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
    return { payload, signature: signWebhookPayload(payload, secret) };
  },
  /** Plays ops refunding the payment in the Dashboard: a refund with no metadata. */
  async dashboardRefund(paymentIntentId: string, amountMinor: number): Promise<Refund> {
    assertNotProduction();
    const payment = await fakeRead<FakePayment>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    return locked(payment.sessionId, async () => {
      const record = await fakeRecord(payment.sessionId);
      const refund: Refund = {
        id: `re_fake_${randomUUID().replaceAll("-", "")}`,
        status: "succeeded",
        amountMinor,
        currency: record.session.currency ?? "usd",
        paymentIntentId,
        ledgerEntryId: null,
        engagementId: null,
        institutionId: null,
        failureReason: null,
      };
      record.refunds.push(refund);
      await fakeWrite(payment.sessionId, record);
      await fakeWrite(refund.id, { sessionId: payment.sessionId });
      return refund;
    });
  },
  /** The objects answer `resource_missing` until shown again, as they would to a key for another account. */
  hide(...ids: string[]): void {
    assertNotProduction();
    for (const id of ids) fakeHidden.add(id);
  },
  show(...ids: string[]): void {
    for (const id of ids) fakeHidden.delete(id);
  },
  /** The next refund create fails as a Stripe 500 would, and its key replays that failure. */
  failNextRefund(): void {
    assertNotProduction();
    fakeRefundOutages += 1;
  },
  /** Refund creates wait, their keys in flight, until `release` is called; `held` settles once one is waiting. */
  holdRefunds(): { held: Promise<void>; release: () => void } {
    assertNotProduction();
    let reached = () => {};
    let open = () => {};
    const held = new Promise<void>((resolve) => (reached = resolve));
    fakeRefundHold = { gate: new Promise<void>((resolve) => (open = resolve)), reached };
    return {
      held,
      release: () => {
        fakeRefundHold = UNHELD;
        open();
      },
    };
  },
  /** Plays the card network bouncing a refund days after it was created. */
  async failRefund(id: string, reason = "expired_or_canceled_card"): Promise<Refund> {
    assertNotProduction();
    const { sessionId } = await fakeRefund(id);
    return locked(sessionId, async () => {
      const { record, refund } = await fakeRefund(id);
      const failed = { ...refund, status: "failed", failureReason: reason };
      record.refunds = record.refunds.map((r) => (r.id === id ? failed : r));
      await fakeWrite(sessionId, record);
      return failed;
    });
  },
  async refundEvent(
    id: string,
    type: "charge.refunded" | "refund.updated" | "refund.failed" | "charge.refund.updated",
  ): Promise<{ payload: string; signature: string }> {
    assertNotProduction();
    const { record, refund } = await fakeRefund(id);
    const metadata = ledgerMetadata(refund);
    const chargeId = refund.paymentIntentId?.replace(/^pi_/, "ch_") ?? null;
    const object =
      type === "charge.refunded"
        ? {
            id: chargeId,
            object: "charge",
            payment_intent: refund.paymentIntentId,
            amount: record.session.amountTotal,
            amount_refunded: record.refunds.filter(isLiveRefund).reduce((sum, r) => sum + r.amountMinor, 0),
            refunded: false,
            metadata,
          }
        : {
            id: refund.id,
            object: "refund",
            amount: refund.amountMinor,
            charge: chargeId,
            payment_intent: refund.paymentIntentId,
            status: refund.status,
            failure_reason: refund.failureReason,
            metadata,
          };
    return signedEvent(type, object);
  },
  /** The next transfer create fails as a Stripe 500 would, and its key replays that failure. */
  failNextTransfer(): void {
    assertNotProduction();
    fakeTransferOutages += 1;
  },
  /** The next transfer is created, then its response is lost on the way back, as a timeout would. */
  loseNextTransferResponse(): void {
    assertNotProduction();
    fakeTransferLostResponses += 1;
  },
  /** Plays ops reversing a transfer in the Dashboard; the whole remainder unless an amount is given. */
  reverseTransfer(id: string, amountMinor?: number): Promise<Transfer> {
    assertNotProduction();
    return locked(id, async () => {
      const transfer = await fakeTransfer(id);
      const left = transfer.amountMinor - transfer.reversedMinor;
      const reversal = { id: `trr_fake_${randomUUID().replaceAll("-", "")}`, amountMinor: amountMinor ?? left };
      if (reversal.amountMinor <= 0 || reversal.amountMinor > left) {
        throw new GatewayError(`Reversal amount (${reversal.amountMinor}) exceeds what is left (${left}).`, { status: 400 });
      }
      const reversed = { ...transfer, reversals: [...transfer.reversals, reversal], reversedMinor: transfer.reversedMinor + reversal.amountMinor };
      await fakeWrite(id, reversed);
      if (transfer.destination) await fakeCredit(transfer.destination, -reversal.amountMinor);
      return reversed;
    });
  },
  /** Plays someone sending money into the engagement's transfer group from the Dashboard, with no metadata. */
  async dashboardTransfer(params: { engagementId: string; accountId: string; amountMinor: number }): Promise<Transfer> {
    assertNotProduction();
    const transfer: Transfer = {
      id: `tr_fake_${randomUUID().replaceAll("-", "")}`,
      amountMinor: params.amountMinor,
      currency: "usd",
      destination: params.accountId,
      transferGroup: params.engagementId,
      sourceTransaction: null,
      ledgerEntryId: null,
      engagementId: null,
      institutionId: null,
      reversals: [],
      reversedMinor: 0,
    };
    const group = `transfer-group-${params.engagementId}`;
    return locked(group, async () => {
      await fakeWrite(transfer.id, transfer);
      await fakeCredit(params.accountId, params.amountMinor);
      await fakeWrite(group, [...((await fakeRead<string[]>(group)) ?? []), transfer.id]);
      return transfer;
    });
  },
  async transferEvent(id: string, type: "transfer.created" | "transfer.reversed"): Promise<{ payload: string; signature: string }> {
    assertNotProduction();
    const transfer = await fakeTransfer(id);
    return signedEvent(type, {
      id,
      object: "transfer",
      amount: transfer.amountMinor,
      amount_reversed: transfer.reversedMinor,
      currency: transfer.currency,
      destination: transfer.destination,
      source_transaction: transfer.sourceTransaction,
      transfer_group: transfer.transferGroup,
      metadata: ledgerMetadata(transfer),
    });
  },
  /** Plays the cardholder's bank opening a chargeback on the payment. */
  async dispute(paymentIntentId: string, reason = "fraudulent"): Promise<Dispute> {
    assertNotProduction();
    const payment = await fakeRead<FakePayment>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    const record = await fakeRecord(payment.sessionId);
    const dispute: Dispute = {
      id: `dp_fake_${randomUUID().replaceAll("-", "")}`,
      paymentIntentId,
      chargeId: paymentIntentId.replace(/^pi_/, "ch_"),
      amountMinor: payment.amountMinor,
      currency: record.session.currency ?? "usd",
      reason,
      status: "needs_response",
      createdAt: new Date(),
    };
    await fakeWrite(dispute.id, dispute);
    return dispute;
  },
  closeDispute(id: string, status: "won" | "lost"): Promise<Dispute> {
    assertNotProduction();
    return locked(id, async () => {
      const closed = { ...(await fakeGateway.retrieveDispute(id)), status };
      await fakeWrite(id, closed);
      return closed;
    });
  },
  async disputeEvent(id: string, type:
      | "charge.dispute.created"
      | "charge.dispute.updated"
      | "charge.dispute.closed"
      | "charge.dispute.funds_withdrawn"
      | "charge.dispute.funds_reinstated"): Promise<{ payload: string; signature: string }> {
    assertNotProduction();
    const dispute = await fakeGateway.retrieveDispute(id);
    return signedEvent(type, {
      id,
      object: "dispute",
      amount: dispute.amountMinor,
      charge: dispute.chargeId,
      payment_intent: dispute.paymentIntentId,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
      created: Math.floor(dispute.createdAt.getTime() / 1000),
    });
  },
  /** A signed event as Stripe would send it, from the session as the fake holds it now. */
  async event(id: string): Promise<{ payload: string; signature: string }> {
    assertNotProduction();
    const record = await fakeRecord(id);
    const type = record.session.status === "complete" ? "checkout.session.completed" : "checkout.session.expired";
    const { params, expiresAt } = record;
    return signedEvent(type, {
      id,
      object: "checkout.session",
      status: record.session.status,
      payment_status: record.session.paymentStatus,
      payment_intent: record.session.paymentIntentId,
      amount_total: record.session.amountTotal,
      currency: record.session.currency,
      expires_at: expiresAt,
      metadata: { engagement_id: params.engagementId, institution_id: params.institutionId },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });
  },
};

/** Signs with the platform endpoint's secret unless given another; only the fake and tests may produce signatures. */
export function signWebhookPayload(payload: string, secret = process.env.STRIPE_WEBHOOK_SECRET): string {
  assertNotProduction();
  if (!secret) throw new GatewayError("STRIPE_WEBHOOK_SECRET is not set.");
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

export function verifyWebhook(payload: string, signature: string | null): WebhookEvent | null {
  if (!signature) return null;
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
    (secret): secret is string => Boolean(secret),
  );
  for (const secret of secrets) {
    try {
      const event = Stripe.webhooks.constructEvent(payload, signature, secret);
      const object = event.data.object as { id?: unknown };
      return {
        id: event.id,
        type: event.type,
        livemode: event.livemode,
        account: event.account ?? null,
        objectId: typeof object.id === "string" ? object.id : null,
      };
    } catch (error) {
      if (!(error instanceof Stripe.errors.StripeSignatureVerificationError)) throw error;
    }
  }
  return null;
}

export function usingFakeStripe(): boolean {
  return process.env.STRIPE_FAKE === "1";
}

let selected: Gateway | null = null;

export function stripeGateway(): Gateway {
  if (usingFakeStripe()) {
    assertNotProduction();
    return fakeGateway;
  }
  selected ??= realGateway();
  return selected;
}
