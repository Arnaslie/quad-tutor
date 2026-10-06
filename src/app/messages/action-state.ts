import { MessagingError } from "@/server/modules/messaging/threads";

export type MessageActionState =
  | { status: "idle" }
  | { status: "sent" }
  | { status: "error"; message: string; draft?: string };

export function failure(error: unknown, draft?: string): MessageActionState {
  if (error instanceof MessagingError) return { status: "error", message: error.message, draft };
  throw error;
}
