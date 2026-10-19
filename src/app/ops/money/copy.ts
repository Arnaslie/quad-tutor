import type { DiscrepancyItem, MoneyForOperator } from "@/server/modules/billing/ops";
import { formatDayTime } from "@/components/format";
import { formatMinor } from "@/server/modules/billing/pricing";

const KIND: Record<DiscrepancyItem["kind"], { title: string; body: string; note?: string }> = {
  checkout_amount: {
    title: "Checkout took the wrong amount",
    body: "Stripe charged a different amount than the package costs, so the package was cancelled and the payment is sent back.",
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

const STOPPED_ROW: Partial<Record<NonNullable<DiscrepancyItem["row"]>["type"], string>> = {
  refund: "the refund to the student",
  tutor_transfer: "the transfer to the tutor",
};

/** A settle button. `heldRefundId` names the held refund it pays by hand; null settles the row the flag names. */
export type SettleChoice = { label: string; pending: string; heldRefundId: string | null };
export type DiscrepancyCopy = { title: string; body: string; note: string | null; settle: SettleChoice[] };

const SETTLE: SettleChoice = { label: "Record manual payment", pending: "Recording…", heldRefundId: null };

/** One button per held refund. Two of the same amount are told apart by the day each was booked. */
function settleHeld(item: DiscrepancyItem): SettleChoice[] {
  return item.held.map((held) => {
    const amount = formatMinor(held.amountMinor, item.currency);
    const twin = item.held.some((other) => other.id !== held.id && other.amountMinor === held.amountMinor);
    return {
      label: `Record ${amount}${twin ? ` from ${formatDayTime(held.bookedAt)}` : ""} as paid by hand`,
      pending: "Recording…",
      heldRefundId: held.id,
    };
  });
}

export function explained(item: DiscrepancyItem): DiscrepancyCopy {
  const { title, body, note = null } = KIND[item.kind];
  const plain = { title, body, note, settle: item.canSettle ? [SETTLE] : [] };
  const charge = item.kind === "ledger_vs_stripe_charge";

  if (charge && item.row?.type === "refund" && item.stripeReference?.startsWith("re_")) {
    return {
      title: "A refund was made in the Stripe Dashboard",
      body: "Someone refunded this payment in the Dashboard, so this refund was stopped rather than sent a second time. Other refunds on this package wait until it is answered.",
      note:
        item.refund === "failed"
          ? "That Dashboard refund then failed at Stripe, so the student did not get it. Pay them another way and record it on the failed refund card for this payment. Once that card is recorded, resolve this."
          : item.canSettle
            ? "Booking it records the Dashboard refund as this refund. If the Ledger and Stripe amounts on this card differ, settle the difference yourself."
            : null,
      settle: item.canSettle ? [{ label: "Book this Dashboard refund", pending: "Booking…", heldRefundId: null }] : [],
    };
  }
  if (charge && item.stripeReference?.startsWith("cs_")) {
    return {
      ...plain,
      title: "Stripe could not find a checkout",
      body: "Stripe said this checkout does not exist, so the package was let go. Stripe found no payment on it.",
      note: "The reconciliation keeps asking Stripe, and clears this if the checkout turns up unpaid. If it turns up paid, the payment is refunded and this stays open for you to resolve.",
    };
  }
  if (item.kind === "checkout_amount" || (charge && item.stripeReference?.startsWith("pi_") && !item.paymentBooked)) {
    return {
      ...plain,
      ...(charge && {
        title: "Stripe took money no package booked",
        body: "The student paid, but no package on the ledger booked the payment, so the payment is sent back.",
      }),
      note: item.refund === "failed"
        ? "Its refund failed at Stripe. Answer it on the failed refund card for this payment, or resolve this if that card is already resolved."
        : item.refundReference
          ? "Stripe has refunded it. Resolve this once you have checked."
          : "The refund has not gone out yet and keeps retrying. Resolving stops the retries.",
    };
  }
  if (item.kind === "refund_failed" && !item.row) {
    if (!item.paymentBooked) {
      return {
        ...plain,
        note: "It returned a payment no package booked. Nothing sends this money again, so pay the student another way, then resolve this with a note on how you paid.",
        settle: [],
      };
    }
    const dashboard = "It was made in the Stripe Dashboard, so no refund row names it.";
    if (item.held.length === 0) {
      return {
        ...plain,
        note: `${dashboard} Nothing on this package is waiting to be refunded. Check the payment's history in Stripe. If this money did not reach the student another way, pay them, then resolve this with how you paid. Until then, any refund the package owes is held back from this card.`,
        settle: [],
      };
    }
    return {
      ...plain,
      note:
        `${dashboard} It holds the package's refunds listed here, so none is sent to the same card. For each one you pay the student another way, record it on its button. ` +
        (item.refund === "holding_stopped"
          ? "Another flag has also stopped one of them for good, so that one can only be paid by hand."
          : "Resolving sends the rest to the same card."),
      settle: settleHeld(item),
    };
  }
  if (item.kind === "refund_failed" && item.row?.type === "refund" && item.canResolve) {
    return {
      ...plain,
      body: "Stripe could not deliver the refund to the student, and nothing sends it again.",
      note: `The package owes them ${formatMinor(item.row.amountMinor, item.currency)}. Pay them that another way, then resolve this with a note on how you paid.`,
      settle: [],
    };
  }
  const stopped = item.canSettle && item.row ? STOPPED_ROW[item.row.type] : undefined;
  if (!stopped) return plain;
  return {
    ...plain,
    note: `It stopped ${stopped}, which was never sent. Resolving would leave it unsent for good, so pay another way and record it here.`,
  };
}

export function lastAnswer(item: DiscrepancyItem): string | null {
  return item.lastAnswer === null ? null : `Last answer: ${item.lastAnswer}`;
}

export function disputeBody(canLift: boolean): string {
  return canLift
    ? "Stripe has closed it. Lifting the pause lets the tutor's pay on this package go out again, unless something else holds it. If they should not be paid, leave it paused."
    : "Stripe has not closed it, so the bank is still deciding. Transfers to the tutor on this package stay paused, and you can lift the pause once it closes.";
}

const count = (n: number, noun: string) => (n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`);

export function heldLine({ refunds, transfers }: MoneyForOperator["held"]): string | null {
  const holding = [count(refunds, "refund"), transfers && `tutor pay on ${count(transfers, "package")}`].filter(Boolean).join(" and ");
  return holding
    ? `The sweeps are holding back ${holding}. This includes any held by a flag that was already resolved.`
    : null;
}
