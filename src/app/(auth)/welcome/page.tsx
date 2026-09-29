import type { Metadata } from "next";

import { CardLink } from "@/components/card";
import { Icon } from "@/components/icons";
import { requireActor } from "@/server/modules/identity/actor";

export const metadata: Metadata = { title: "Welcome" };

const CHOICES = [
  {
    href: "/courses",
    icon: "book",
    title: "I need help",
    description: "Pick your course and see tutors who already took it.",
  },
  {
    href: "/tutor/start",
    icon: "cap",
    title: "I'm a tutor",
    description: "Help with a course you already took, and get paid for it.",
  },
] as const;

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
        {CHOICES.map((choice) => (
          <CardLink key={choice.href} href={choice.href} className="flex items-center gap-4">
            <Icon name={choice.icon} className="size-6 shrink-0 text-accent" />
            <span className="flex flex-1 flex-col gap-1">
              <span className="text-lg font-medium">{choice.title}</span>
              <span className="text-sm text-muted">{choice.description}</span>
            </span>
            <Icon name="arrow-right" className="size-5 shrink-0 text-muted" />
          </CardLink>
        ))}
      </div>

      <p className="text-center text-sm text-muted">
        One account does both. You can switch sides any time.
      </p>
    </div>
  );
}
