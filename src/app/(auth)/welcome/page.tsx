import type { Metadata } from "next";

import { CardButton, CardLink } from "@/components/card";
import { Icon, type IconName } from "@/components/icons";
import { requireActor } from "@/server/modules/identity/actor";
import { startTutoring } from "@/app/(tutor)/tutor/actions";

export const metadata: Metadata = { title: "Welcome" };

function Choice({
  icon,
  title,
  description,
}: {
  icon: IconName;
  title: string;
  description: string;
}) {
  return (
    <span className="flex items-center gap-4">
      <Icon name={icon} className="size-6 shrink-0 text-accent" />
      <span className="flex flex-1 flex-col gap-1">
        <span className="text-lg font-medium">{title}</span>
        <span className="text-sm text-muted">{description}</span>
      </span>
      <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
    </span>
  );
}

export default async function WelcomePage() {
  const actor = await requireActor();
  const firstName = actor.name.split(" ")[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome{firstName ? `, ${firstName}` : ""}
        </h1>
        <p className="text-base text-muted">What brings you here?</p>
      </div>

      <div className="flex flex-col gap-3">
        <CardLink href="/courses">
          <Choice
            icon="book"
            title="I need help"
            description="Pick your course and see tutors who already took it."
          />
        </CardLink>

        {/* A form, not a link: creating the tutor profile is a write, and links get prefetched. */}
        <form action={startTutoring}>
          <CardButton type="submit">
            <Choice
              icon="cap"
              title="I'm a tutor"
              description="Help with a course you already took, and get paid for it."
            />
          </CardButton>
        </form>
      </div>

      <p className="text-center text-sm text-muted">
        One account does both. You can switch sides any time.
      </p>
    </div>
  );
}
