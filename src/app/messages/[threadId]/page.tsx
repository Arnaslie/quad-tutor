import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { requireActor } from "@/server/modules/identity/actor";
import { MessagingError, threadView, type ThreadView } from "@/server/modules/messaging/threads";

import { MessageList } from "../message-list";
import { Composer } from "./composer";
import { ThreadTools } from "./thread-tools";

export const metadata: Metadata = { title: "Conversation" };

export default async function ThreadPage(props: PageProps<"/messages/[threadId]">) {
  const { threadId } = await props.params;
  if (!z.uuid().safeParse(threadId).success) notFound();
  const actor = await requireActor();

  let thread: ThreadView;
  try {
    thread = await threadView(actor, threadId);
  } catch (error) {
    if (error instanceof MessagingError) notFound();
    throw error;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={`${thread.courseLabel} · ${thread.side === "tutor" ? "Student" : "Tutor"}`}
        title={thread.otherName}
        action={
          <ButtonLink href="/messages" variant="secondary">
            All messages
          </ButtonLink>
        }
      />

      <MessageList
        messages={thread.messages}
        empty={`Nothing here yet. Say hello, ask about times, or sort out where to meet.`}
      />

      <Footer thread={thread} />

      <ThreadTools threadId={thread.id} otherName={thread.otherName} blockedByMe={thread.blockedByMe} />
    </div>
  );
}

function Footer({ thread }: { thread: ThreadView }) {
  if (thread.blocked) {
    return (
      <Card className="text-sm text-muted">
        {thread.blockedByMe
          ? `You blocked ${thread.otherName}. Neither of you can send messages here until you unblock them.`
          : "Messages are turned off in this conversation."}
      </Card>
    );
  }

  if (!thread.open) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted">
          {thread.side === "student"
            ? `There is no open request or package with ${thread.otherName}, so this conversation is closed. Book again and it opens back up.`
            : `This conversation is closed. It opens again if ${thread.otherName} books you.`}
        </p>
        {thread.bookAgainHref ? (
          <ButtonLink href={thread.bookAgainHref}>Book again</ButtonLink>
        ) : null}
      </Card>
    );
  }

  return (
    <>
      {thread.bookAgainHref ? (
        <ButtonLink href={thread.bookAgainHref} variant="secondary" className="self-start">
          Book again
        </ButtonLink>
      ) : null}
      <Composer threadId={thread.id} />
    </>
  );
}
