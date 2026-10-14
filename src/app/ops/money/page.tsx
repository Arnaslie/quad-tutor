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
import { disputeBody, explained, heldLine } from "./copy";
import { NoteForm, type NoteChoice } from "./note-form";
import { ReversalForm } from "./reversal-form";

export const metadata: Metadata = { title: "Money" };

const RESOLVE: NoteChoice = { action: resolveDiscrepancyAction, label: "Resolve", pending: "Resolving…", variant: "secondary" };
const NOTE_HINT = "What you checked or did. It is saved with your name.";

type Fact = [label: string, value: ReactNode] | false;

export default async function MoneyPage() {
  const operator = await requireOperator();
  const { disputes, reversals, discrepancies, orphanedAccounts, held } = await moneyForOperator(operator);
  const clear = disputes.length + reversals.length + discrepancies.length + orphanedAccounts.length === 0;
  const holding = heldLine(held);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Money"
        description="Where Stripe and the ledger disagree, and money that waits on your answer. Each answer is saved with your name."
      />

      {holding ? (
        <p className="rounded-2xl bg-surface-sunken px-4 py-3 text-sm">{holding}</p>
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
            hint={NOTE_HINT}
            choices={[{ action: liftDisputePauseAction, label: "Lift the pause", pending: "Lifting…" }]}
          />
        ) : null
      }
    >
      <p>{disputeBody(dispute.canLift)}</p>
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
  const choices = [
    ...(settle ? [{ action: recordManualPaymentAction, ...settle }] : []),
    ...(item.canResolve ? [RESOLVE] : []),
  ];

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
      action={choices.length > 0 ? <NoteForm id={item.id} hint={NOTE_HINT} choices={choices} /> : null}
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
