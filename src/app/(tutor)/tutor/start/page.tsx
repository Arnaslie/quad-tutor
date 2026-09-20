import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { PageHeader } from "@/components/page-header";
import { Icon } from "@/components/icons";
import { becomeTutor, requireActor } from "@/server/modules/identity/actor";

export const metadata: Metadata = { title: "Become a tutor" };

const POINTS = [
  "You list the courses you have already taken, with proof of the grade.",
  "Students ask; you accept or pass. Passing costs you nothing.",
  "Payout details come later — only once you accept your first request.",
];

export default async function TutorStartPage() {
  const actor = await requireActor();
  if (actor.tutorProfileId) redirect("/tutor");

  async function start() {
    "use server";
    // Re-resolve from the session rather than closing over the actor above: a
    // Server Action is a reachable POST endpoint, not just a button.
    const current = await requireActor();
    await becomeTutor(current);

    // Layouts are cached client-side and do not re-render on navigation, so
    // without this the tutor shell arrives with no tabs and the student shell
    // keeps offering "Become a tutor" to someone who just became one. Both
    // headers read the tutor profile, so both have to be invalidated.
    revalidatePath("/", "layout");
    redirect("/tutor");
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <PageHeader
        title="Tutor on your campus"
        description="You are already a student here. Tutoring is the same account, a different surface — you can move between the two whenever you like."
      />

      <Card>
        <ul className="flex flex-col gap-3">
          {POINTS.map((point) => (
            <li key={point} className="flex gap-3 text-sm text-foreground">
              <Icon name="check" className="mt-0.5 size-[18px] shrink-0 text-accent" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </Card>

      <form action={start}>
        <Button type="submit" size="lg" className="w-full sm:w-auto">
          Set up my tutor profile
        </Button>
      </form>

      <p className="text-sm text-muted">
        Nothing is published until you add a course you can prove you took.
      </p>
    </div>
  );
}
