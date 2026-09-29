import { ButtonLink } from "@/components/button";
import { Icon } from "@/components/icons";

export function MessageLink({ threadId, className }: { threadId: string | null; className?: string }) {
  if (!threadId) return null;

  return (
    <ButtonLink href={`/messages/${threadId}`} prefetch={false} variant="secondary" className={className}>
      <Icon name="chat" className="size-[18px]" />
      Message
    </ButtonLink>
  );
}
