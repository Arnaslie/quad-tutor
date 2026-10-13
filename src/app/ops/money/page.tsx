import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { formatDayTime } from "@/components/format";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import {
  moneyForOperator,
  type DiscrepancyItem,
  type DisputeItem,
  type EngagementContext,
  type OrphanedAccountItem,
  type ReversalItem,
} from "@/server/modules/billing/ops";
import { requireOperator } from "@/server/modules/identity/actor";

import {
  liftDisputePauseAction,
  recordManualPaymentAction,
  resolveDiscrepancyAction,
} from "./actions";
import { NoteForm, type NoteChoice } from "./note-form";
import { ReversalForm } from "./reversal-form";

export const metadata: Metadata = { title: "Money" };

const RESOLVE: NoteChoice = { action: resolveDiscrepancyAction, label: "Resolve", pending: "Resolving…", variant: "secondary" };
const NOTE_HINT = "What you checked or did. It is saved with your name.";

const KIND: Record<DiscrepancyItem["kind"], { title: string; body: string }> = {
  checkout_amount: {
    title: "Checkout took the wrong amount",
    body: "Stripe charged a different amount than the package costs, so the package was cancelled and the payment goes back to the student on its own.",
  },
  ledger_vs_stripe_charge: {
    title: "A charge does not match the ledger",
    body: "What Stripe kept for this payment, after refunds, is not what the ledger booked. Check the payment in the Dashboard.",
  },
  ledger_vs_stripe_transfers: {
    title: "Tutor pay does not match the ledger",
    body: "What Stripe sent the tutor for this package, after reversals, is not what the ledger booked, or Stripe refused a transfer.",
  },
  unstamped_reference: {
    title: "Stripe has not confirmed a payment",
    body: "A refund, tutor transfer or checkout from over a day ago still has no Stripe id. This flag does not stop its retries or pause the tutor's transfers, and it clears itself once Stripe answers.",
  },
  refund_failed: {
    title: "A refund to the student failed",
    body: "Stripe could not return this money to the student's card, usually because the card is closed or lost. Nothing sends it to that card again.",
  },
};

const STOPPED_ROW: Partial<Record<NonNullable<DiscrepancyItem["ledgerEntryType"]>, string>> = {
  refund: "the refund to the student",
  tutor_transfer: "the transfer to the tutor",
};

type Fact = [label: string, value: ReactNode] | false;

export default async function MoneyPage() {
  const operator = await requireOperator();
  const { disputes, reversals, discrepancies, orphanedAccounts, held } = await moneyForOperator(operator);
  const clear = disputes.length + reversals.length + discrepancies.length + orphanedAccounts.length === 0;
  const holding = [count(held.refunds, "refund"), count(held.transfers, "tutor transfer")].filter(Boolean).join(" and ");

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Money"
        description="Where Stripe and the ledger disagree, and money that waits on your answer. Each answer is saved with your name."
      />

      {holding ? (
        <p className="rounded-2xl bg-surface-sunken px-4 py-3 text-sm">The sweeps are holding {holding} for you.</p>
      ) : null}

      {clear ? (
        <EmptyState icon="bank" title="Nothing to answer" description="Stripe and the ledger agree, and no dispute or reversal is waiting on you." />
      ) : null}

      <Section
        title="Disputes"
        description="A student disputed a charge with their bank. Tutor transfers on that package stay paused until you lift the pause."
        items={disputes}
        render={(dispute) => <Dispute dispute={dispute} />}
      />
      <Section
        title="Reversed transfers"
        description="Stripe took back money sent to a tutor. It is still owed to them until you answer."
        items={reversals}
        render={(reversal) => <Reversal reversal={reversal} />}
      />
      <Section
        title="Discrepancies"
        description="The ledger and Stripe disagree. Tutor transfers on the package wait while one is open, unless it says otherwise."
        items={discrepancies}
        render={(item) => <Discrepancy item={item} />}
      />
      <Section
        title="Unused payout accounts"
        description="Stripe has a payout account with this campus's id that no tutor holds. It pauses nothing."
        items={orphanedAccounts}
        render={(account) => <OrphanedAccount account={account} />}
      />
    </div>
  );
}

function count(n: number, noun: string) {
  return n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const humanize = (value: string) => value.replaceAll("_", " ");

function Section<T extends { id: string }>({
  title,
  description,
  items,
  render,
}: {
  title: string;
  description: string;
  items: T[];
  render: (item: T) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <ul className="flex flex-col gap-4">
        {items.map((item) => (
          <li key={item.id}>{render(item)}</li>
        ))}
      </ul>
    </section>
  );
}

function ItemCard({
  eyebrow,
  title,
  facts,
  children,
  action,
}: {
  eyebrow: string;
  title: ReactNode;
  facts: Fact[];
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <Card className={action ? "grid gap-5 md:grid-cols-[1fr_20rem]" : "grid gap-5"}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{eyebrow}</p>
          <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        </div>
        <div className="flex flex-col gap-2 text-sm">{children}</div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {facts.filter((fact) => fact !== false).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {action ? <div>{action}</div> : null}
    </Card>
  );
}

function StripeId({ id }: { id: string }) {
  return <code className="select-all break-all font-mono text-xs text-muted">{id}</code>;
}

function people(engagement: EngagementContext | null): Fact[] {
  if (!engagement) return [];
  return [
    ["Course", engagement.courseLabel],
    ["Tutor", engagement.tutorName],
    ["Student", engagement.studentName],
  ];
}

function Dispute({ dispute }: { dispute: DisputeItem }) {
  return (
    <ItemCard
      eyebrow={`Opened ${formatDayTime(dispute.openedAt)}`}
      title={
        <>
          <Money minor={dispute.amountMinor} currency={dispute.currency} /> disputed
        </>
      }
      facts={[
        ...people(dispute.engagement),
        ["Reason", dispute.reason ? humanize(dispute.reason) : "Not given"],
        ["At Stripe", humanize(dispute.status)],
        dispute.closedAt !== null && ["Closed", formatDayTime(dispute.closedAt)],
        ["Dispute", <StripeId key="id" id={dispute.stripeDisputeId} />],
      ]}
      action={
        dispute.canLift ? (
          <NoteForm
            id={dispute.id}
            hint="What it means for the tutor's pay. It is saved with your name."
            choices={[{ action: liftDisputePauseAction, label: "Lift the pause", pending: "Lifting…" }]}
          />
        ) : null
      }
    >
      <p>
        {dispute.canLift
          ? "Stripe has closed it. Decide what the outcome means for the tutor's pay, then lift the pause."
          : "Stripe has not closed it, so the bank is still deciding. Transfers to the tutor on this package stay paused, and you can lift the pause once it closes."}
      </p>
    </ItemCard>
  );
}

function Reversal({ reversal }: { reversal: ReversalItem }) {
  return (
    <ItemCard
      eyebrow={`Booked ${formatDayTime(reversal.bookedAt)}`}
      title={
        <>
          <Money minor={reversal.amountMinor} currency={reversal.currency} /> taken back
        </>
      }
      facts={[...people(reversal.engagement), ["Reversal", <StripeId key="id" id={reversal.reference} />]]}
      action={<ReversalForm id={reversal.id} paused={reversal.paused} />}
    >
      <p>The tutor is owed this money again. Nothing sends it until you answer.</p>
      {reversal.paused ? (
        <p className="text-muted">A dispute or a discrepancy has paused this package.</p>
      ) : null}
    </ItemCard>
  );
}

const SETTLE = { label: "Record manual payment", pending: "Recording…" };

function explained(item: DiscrepancyItem): { title: string; body: string; note: string | null; settle: typeof SETTLE } {
  const { title, body } = KIND[item.kind];
  const plain = { title, body, note: null, settle: SETTLE };

  if (item.kind === "ledger_vs_stripe_charge" && item.ledgerEntryType === "refund" && item.stripeReference?.startsWith("re_")) {
    return {
      title: "A refund was made in the Stripe Dashboard",
      body: "Someone refunded this payment in the Dashboard, so the package refund was stopped rather than sent a second time.",
      note: "Booking it records the Dashboard refund as the package refund. If the two amounts differ, the difference comes back as a flag on the payment.",
      settle: { label: "Book this Dashboard refund", pending: "Booking…" },
    };
  }
  if (item.kind === "checkout_amount" || (item.kind === "ledger_vs_stripe_charge" && item.stripeReference?.startsWith("pi_") && !item.paymentBooked)) {
    return {
      ...plain,
      ...(item.kind === "ledger_vs_stripe_charge" && {
        title: "Stripe took money no package booked",
        body: "The student paid, but no package on the ledger booked the payment, so it goes back to them on its own.",
      }),
      note: item.refundReference
        ? "Stripe has refunded it. Resolve this once you have checked."
        : item.refund === "retrying"
          ? "The refund has not gone out yet and keeps retrying. Resolving now stops it."
          : "Its refund failed and is not retried. The failed refund has its own card here.",
    };
  }
  if (item.kind === "refund_failed" && !item.ledgerEntryType) {
    return {
      ...plain,
      note:
        "No refund row names it: it was made in the Stripe Dashboard, or it returned a payment the ledger never booked. " +
        (item.refund === "holding"
          ? "It holds the package's refund so it is not sent to the same card. If you paid the student another way, record it, and the package refund waiting is marked paid and never sent. Resolving instead sends the package refund to the same card."
          : "The package has no refund waiting yet. Resolving or recording a manual payment both close this, and a refund the package owes later goes to the same card."),
    };
  }
  const stopped = item.canSettle && item.ledgerEntryType ? STOPPED_ROW[item.ledgerEntryType] : undefined;
  if (!stopped) return plain;
  return {
    ...plain,
    note: item.canResolve
      ? `It stopped ${stopped}. Resolving does not send it again, so if you paid another way, record a manual payment instead.`
      : `It stopped ${stopped}, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.`,
  };
}

function amounts(item: DiscrepancyItem): Fact[] {
  const money = (label: string, minor: number | null): Fact =>
    minor !== null && [label, <Money key={label} minor={minor} currency={item.currency} />];
  if (item.kind === "refund_failed") {
    return [money("Failed refund", item.ledgerAmountMinor), money("Package refund waiting", item.heldRefundMinor)];
  }
  return [money("Ledger", item.ledgerAmountMinor), money("Stripe", item.stripeAmountMinor)];
}

function Discrepancy({ item }: { item: DiscrepancyItem }) {
  const { title, body, note, settle } = explained(item);

  return (
    <ItemCard
      eyebrow={`Found ${formatDayTime(item.detectedAt)}`}
      title={title}
      facts={[
        ...people(item.engagement),
        ...amounts(item),
        item.stripeReference !== null && ["Stripe id", <StripeId key="ref" id={item.stripeReference} />],
        item.refundReference !== null && ["Refund", <StripeId key="refund" id={item.refundReference} />],
      ]}
      action={
        <NoteForm
          id={item.id}
          hint={NOTE_HINT}
          choices={[
            ...(item.canSettle ? [{ action: recordManualPaymentAction, ...settle }] : []),
            ...(item.canResolve ? [RESOLVE] : []),
          ]}
        />
      }
    >
      <p>{body}</p>
      {note ? <p className="text-muted">{note}</p> : null}
    </ItemCard>
  );
}

function OrphanedAccount({ account }: { account: OrphanedAccountItem }) {
  return (
    <ItemCard
      eyebrow={`Found ${formatDayTime(account.detectedAt)}`}
      title="A payout account no tutor holds"
      facts={[["Account", <StripeId key="id" id={account.accountId} />]]}
      action={<NoteForm id={account.id} hint={NOTE_HINT} choices={[RESOLVE]} />}
    >
      <p>Check it in the Dashboard. Close it there if nobody needs it, then resolve this.</p>
    </ItemCard>
  );
}
