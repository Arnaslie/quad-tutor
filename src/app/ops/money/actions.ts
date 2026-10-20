"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";

import {
  answerReversal,
  liftDisputePause,
  recordManualSettlement,
  resolveDiscrepancy,
} from "@/server/modules/billing/ops";
import { errorFacts } from "@/server/modules/billing/stripe";
import { sendTransferRow } from "@/server/modules/billing/transfers";
import { requireOperator, type OperatorActor } from "@/server/modules/identity/actor";

/** The note comes back on an error so the form can keep what was typed. */
export type MoneyFormState = { error: string; note?: string } | null;

const GONE = "Someone already dealt with this one.";

const id = z.uuid({ error: GONE });
const noted = z.object({
  id,
  note: z
    .string({ error: "Add a note." })
    .trim()
    .min(3, { error: "Say what you checked or did, in a few words." })
    .max(500, { error: "Keep the note to 500 characters." }),
});
const answered = z.object({
  id,
  answer: z.enum(["resend", "manual", "forfeited"], { error: "Pick an answer." }),
});

type Written<R extends string> = { ok: true } | { ok: false; refusal: R };

async function withNote<R extends string>(
  formData: FormData,
  write: (operator: OperatorActor, id: string, note: string) => Promise<Written<R>>,
  refusals: Record<R, string>,
): Promise<MoneyFormState> {
  const operator = await requireOperator();
  const note = String(formData.get("note") ?? "");
  const parsed = noted.safeParse({ id: formData.get("id"), note });
  if (!parsed.success) return { error: parsed.error.issues[0].message, note };

  const result = await write(operator, parsed.data.id, parsed.data.note);
  if (!result.ok) return { error: refusals[result.refusal], note };
  revalidatePath("/ops/money");
  return null;
}

export async function resolveDiscrepancyAction(_previous: MoneyFormState, formData: FormData) {
  return withNote(
    formData,
    (operator, discrepancyId, note) => resolveDiscrepancy({ operator, discrepancyId, note }),
    {
      gone: GONE,
      settle_instead: "Resolving would leave this money unsent for good. Pay another way, then record it as a manual payment.",
    },
  );
}

/** Bound per button: `heldRefundId` names the held refund it pays, or is null for the row the flag names. */
export async function recordManualPaymentAction(heldRefundId: string | null, _previous: MoneyFormState, formData: FormData) {
  const held = id.nullable().safeParse(heldRefundId);
  if (!held.success) return { error: GONE, note: String(formData.get("note") ?? "") };
  return withNote(
    formData,
    (operator, discrepancyId, note) =>
      recordManualSettlement({ operator, discrepancyId, note, heldRefundId: held.data ?? undefined }),
    {
      gone: GONE,
      not_settleable: "Something changed on this one. Reload the page to see what is left to do.",
    },
  );
}

export async function liftDisputePauseAction(_previous: MoneyFormState, formData: FormData) {
  return withNote(
    formData,
    (operator, disputeId, note) => liftDisputePause({ operator, disputeId, note }),
    { gone: GONE, open_at_stripe: "Stripe has not closed this dispute yet." },
  );
}

export async function answerReversalAction(
  _previous: MoneyFormState,
  formData: FormData,
): Promise<MoneyFormState> {
  const operator = await requireOperator();
  const parsed = answered.safeParse({ id: formData.get("id"), answer: formData.get("answer") });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const result = await answerReversal({ operator, reversalId: parsed.data.id, answer: parsed.data.answer });
  if (!result.ok) {
    return {
      error: {
        gone: GONE,
        answered: "Someone already answered this reversal.",
        paused: "This package is paused, so it cannot be sent again yet. Lift the pause first, or pick another answer.",
      }[result.refusal],
    };
  }

  const row = result.resend;
  if (row) {
    after(() =>
      sendTransferRow(row).catch((error) =>
        console.error(`[transfer] ${row.id} left for the retry sweep`, errorFacts(error)),
      ),
    );
  }
  revalidatePath("/ops/money");
  return null;
}
