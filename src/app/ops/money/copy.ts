import type { DiscrepancyItem, MoneyForOperator } from "@/server/modules/billing/ops";

const KIND: Record<DiscrepancyItem["kind"], { title: string; body: string; note?: string }> = {
  checkout_amount: {
    title: "Checkout took the wrong amount",
    body: "Stripe charged a different amount than the package costs, so the package was cancelled and the payment is refunded.",
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
    body: "A refund or tutor transfer from over a day ago still has no Stripe id, or a checkout was let go before Stripe gave it one. This flag does not stop retries or pause the tutor's transfers.",
    note: "It clears itself once every row has its Stripe id, or a day after a checkout was let go if Stripe holds no payment for it. If the student did pay, the payment is refunded and this stays open for you to resolve.",
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

export type SettleLabel = { label: string; pending: string };
export type DiscrepancyCopy = { title: string; body: string; note: string | null; settle: SettleLabel | null };

const SETTLE: SettleLabel = { label: "Record manual payment", pending: "Recording…" };

export function explained(item: DiscrepancyItem): DiscrepancyCopy {
  const { title, body, note = null } = KIND[item.kind];
  const plain = { title, body, note, settle: item.canSettle ? SETTLE : null };
  const charge = item.kind === "ledger_vs_stripe_charge";

  if (charge && item.ledgerEntryType === "refund" && item.stripeReference?.startsWith("re_")) {
    return {
      title: "A refund was made in the Stripe Dashboard",
      body: "Someone refunded this payment in the Dashboard, so the package refund was stopped rather than sent a second time.",
      note: item.canSettle
        ? "Booking it records the Dashboard refund as the package refund. If the two amounts differ, the difference comes back as a flag on the payment."
        : null,
      settle: item.canSettle ? { label: "Book this Dashboard refund", pending: "Booking…" } : null,
    };
  }
  if (charge && item.stripeReference?.startsWith("cs_")) {
    return {
      ...plain,
      title: "Stripe could not find a checkout",
      body: "Stripe said this checkout does not exist, so the package was let go. Nothing was charged on it.",
      note: "The reconciliation keeps asking Stripe, and clears this if the checkout turns up unpaid. If it turns up paid, the payment is refunded and this stays open for you to resolve.",
    };
  }
  if (item.kind === "checkout_amount" || (charge && item.stripeReference?.startsWith("pi_") && !item.paymentBooked)) {
    return {
      ...plain,
      ...(charge && {
        title: "Stripe took money no package booked",
        body: "The student paid, but no package on the ledger booked the payment, so the payment is refunded.",
      }),
      note: item.refund === "failed"
        ? "Its refund failed at Stripe. Answer it on the failed refund card for this payment."
        : item.refundReference
          ? "Stripe has refunded it. Resolve this once you have checked."
          : item.refund === "retrying"
            ? "The refund has not gone out yet and keeps retrying. Resolving stops the retries."
            : "Its refund failed and is not retried.",
    };
  }
  if (item.kind === "refund_failed" && !item.ledgerEntryType) {
    if (!item.paymentBooked) {
      return {
        ...plain,
        note: "It returned a payment no package booked. Nothing sends this money again, so pay the student another way, then record it.",
      };
    }
    return {
      ...plain,
      note:
        "It was made in the Stripe Dashboard, so no refund row names it. " +
        (item.refund === "holding"
          ? "It holds the package's refund so it is not sent to the same card. If you paid the student another way, record it, and the package refund waiting is marked paid and never sent. Resolving instead sends the package refund to the same card."
          : "The package has no refund waiting yet. Resolving or recording a manual payment both close this, and a refund the package owes later goes to the same card."),
    };
  }
  if (item.kind === "refund_failed" && item.ledgerEntryType === "refund" && item.canResolve) {
    return {
      ...plain,
      body: "Stripe could not deliver the refund to the student, and nothing sends it again.",
      note: "Pay them another way, then resolve this with a note on how you paid.",
      settle: null,
    };
  }
  const stopped = item.canSettle && item.ledgerEntryType ? STOPPED_ROW[item.ledgerEntryType] : undefined;
  if (!stopped) return plain;
  return {
    ...plain,
    note: `It stopped ${stopped}, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.`,
  };
}

export function disputeBody(canLift: boolean): string {
  return canLift
    ? "Stripe has closed it. Lifting the pause lets the tutor's pay on this package go out again, unless something else holds it. If they should not be paid, leave it paused."
    : "Stripe has not closed it, so the bank is still deciding. Transfers to the tutor on this package stay paused, and you can lift the pause once it closes.";
}

const count = (n: number, noun: string) => (n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`);

export function heldLine({ refunds, transfers }: MoneyForOperator["held"]): string | null {
  const holding = [count(refunds, "refund"), count(transfers, "tutor transfer")].filter(Boolean).join(" and ");
  return holding
    ? `The sweeps are holding back ${holding}. This includes any held by a flag that was already resolved.`
    : null;
}
