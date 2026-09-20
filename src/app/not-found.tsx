import { ButtonLink } from "@/components/button";
import { EmptyState } from "@/components/empty-state";

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10">
      <EmptyState
        icon="arrow-right"
        title="Nothing here"
        description="That page does not exist, or it moved. Course codes get renumbered between terms — links do not."
        action={<ButtonLink href="/">Back to your courses</ButtonLink>}
      />
    </div>
  );
}
