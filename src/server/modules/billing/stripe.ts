import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Stripe from "stripe";

const API_VERSION = "2026-09-30.endive";
const MIN_EXPIRY_SECONDS = 30 * 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type ErrorFacts = { status?: number; code?: string; param?: string; idempotency?: boolean };

export class GatewayError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly param?: string;
  readonly idempotency: boolean;

  constructor(message: string, facts: ErrorFacts = {}, options?: ErrorOptions) {
    super(message, options);
    this.status = facts.status;
    this.code = facts.code;
    this.param = facts.param;
    this.idempotency = facts.idempotency ?? false;
  }

  get missing(): boolean {
    return this.code === "resource_missing";
  }
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

export type Refund = { id: string; status: string | null };

export type WebhookEvent = {
  id: string;
  type: string;
  livemode: boolean;
  account: string | null;
  objectId: string | null;
};

export type Gateway = {
  livemode: boolean;
  createCheckout(params: NewCheckout): Promise<CheckoutSession>;
  retrieveCheckout(id: string): Promise<CheckoutSession>;
  expireCheckout(id: string): Promise<CheckoutSession>;
  /** A paid Checkout Session for this engagement, found through its PaymentIntents' metadata. */
  findPaidCheckout(engagementId: string): Promise<CheckoutSession | null>;
  chargeFee(paymentIntentId: string): Promise<ChargeFee>;
  listRefunds(paymentIntentId: string): Promise<Refund[]>;
  refund(params: { paymentIntentId: string; engagementId: string; institutionId: string }): Promise<Refund>;
};

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
        idempotency: error instanceof Stripe.errors.StripeIdempotencyError && error.statusCode === 400,
      },
      { cause: error },
    );
  }
}

function realGateway(): Gateway {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new GatewayError("STRIPE_SECRET_KEY is not set.");
  const livemode = key.startsWith("sk_live_");
  if (livemode && process.env.VERCEL_ENV !== "production") {
    throw new GatewayError("A live Stripe key is refused outside production.");
  }
  const stripe = new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2 });

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
    listRefunds: (paymentIntentId) =>
      call(async () => {
        const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 10 });
        return refunds.data.map((refund) => ({ id: refund.id, status: refund.status }));
      }),
    refund: (params) =>
      call(async () => {
        const refund = await stripe.refunds.create(
          {
            payment_intent: params.paymentIntentId,
            metadata: { engagement_id: params.engagementId, institution_id: params.institutionId },
          },
          { idempotencyKey: `refund:${params.paymentIntentId}` },
        );
        return { id: refund.id, status: refund.status };
      }),
  };
}

type FakeRecord = {
  session: CheckoutSession;
  expiresAt: number;
  params: NewCheckout;
  refunds: Refund[];
};

const fakeDir = () => path.join(tmpdir(), "quad-tutor-stripe-fake");
const fakeFile = (name: string) => path.join(fakeDir(), `${name.replace(/[^\w-]/g, "_")}.json`);

async function fakeRead<T>(name: string): Promise<T | null> {
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
    const payment = await fakeRead<{ sessionId: string; amountMinor: number }>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    return {
      feeMinor: Math.round((payment.amountMinor * 29) / 1000) + 30,
      balanceTransactionId: `txn_${paymentIntentId}`,
    };
  },
  async listRefunds(paymentIntentId) {
    const payment = await fakeRead<{ sessionId: string }>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    return (await fakeRecord(payment.sessionId)).refunds;
  },
  async refund({ paymentIntentId }) {
    const payment = await fakeRead<{ sessionId: string }>(paymentIntentId);
    if (!payment) throw missing("payment_intent", paymentIntentId);
    return locked(payment.sessionId, async () => {
      const record = await fakeRecord(payment.sessionId);
      const existing = record.refunds.at(0);
      if (existing) return existing;
      const refund = { id: `re_fake_${randomUUID().replaceAll("-", "")}`, status: "succeeded" };
      record.refunds.push(refund);
      await fakeWrite(payment.sessionId, record);
      return refund;
    });
  },
};

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
  /** A signed event as Stripe would send it, from the session as the fake holds it now. */
  async event(id: string): Promise<{ payload: string; signature: string }> {
    assertNotProduction();
    const record = await fakeRecord(id);
    const type = record.session.status === "complete" ? "checkout.session.completed" : "checkout.session.expired";
    const { params, expiresAt } = record;
    const payload = JSON.stringify({
      id: `evt_fake_${randomUUID().replaceAll("-", "")}`,
      object: "event",
      api_version: API_VERSION,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      type,
      data: {
        object: {
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
        },
      },
    });
    return { payload, signature: signWebhookPayload(payload) };
  },
};

/** Signs with the platform endpoint's secret; only the fake and tests may produce signatures. */
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
