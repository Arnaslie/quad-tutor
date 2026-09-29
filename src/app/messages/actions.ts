"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireActor } from "@/server/modules/identity/actor";
import { alertThread } from "@/server/modules/messaging/alerts";
import { blockInput, reportInput, sendInput } from "@/server/modules/messaging/input";
import {
  MessagingError,
  blockThread,
  sendMessage,
} from "@/server/modules/messaging/threads";
import { reportThread } from "@/server/modules/messaging/reports";

export type MessageActionState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; message: string; draft?: string };

function failure(error: unknown, draft?: string): MessageActionState {
  if (error instanceof MessagingError) return { status: "error", message: error.message, draft };
  throw error;
}

export async function sendAction(
  _previous: MessageActionState,
  formData: FormData,
): Promise<MessageActionState> {
  const actor = await requireActor();
  const parsed = sendInput.safeParse({
    threadId: formData.get("threadId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "That message can't be sent.",
      draft: String(formData.get("body") ?? ""),
    };
  }

  try {
    const { recipient } = await sendMessage({ actor, ...parsed.data });
    after(() =>
      alertThread(parsed.data.threadId, recipient).catch((error) =>
        console.error(`[messages] alert for ${parsed.data.threadId} failed`, error),
      ),
    );
  } catch (error) {
    return failure(error, parsed.data.body);
  }

  revalidatePath(`/messages/${parsed.data.threadId}`);
  return { status: "sent" };
}

export async function reportAction(
  _previous: MessageActionState,
  formData: FormData,
): Promise<MessageActionState> {
  const actor = await requireActor();
  const parsed = reportInput.safeParse({
    threadId: formData.get("threadId"),
    reason: formData.get("reason"),
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Pick a reason." };
  }

  try {
    await reportThread({ actor, ...parsed.data });
  } catch (error) {
    return failure(error);
  }
  return { status: "sent" };
}

export async function blockAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const parsed = blockInput.safeParse({
    threadId: formData.get("threadId"),
    blocked: formData.get("blocked"),
  });
  if (!parsed.success) return;

  try {
    await blockThread({ actor, ...parsed.data });
  } catch (error) {
    if (!(error instanceof MessagingError)) throw error;
  }
  revalidatePath(`/messages/${parsed.data.threadId}`);
}
