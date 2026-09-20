import type { Metadata } from "next";

import { Button } from "@/components/button";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { SESSION_MINUTES } from "@/server/modules/engagements/attendance";
import { requireTutor } from "@/server/modules/identity/actor";
import { availabilityForTutor } from "@/server/modules/tutoring/availability";
// The pure half lives apart from the database half on purpose — see the note
// in `windows.ts` and the bundling convention in CLAUDE.md.
import {
  slotsPerWeek,
  type AvailabilityWindow,
} from "@/server/modules/tutoring/windows";

import { removeAvailabilityAction } from "./actions";
import { AvailabilityForm } from "./availability-form";
import { WEEKDAYS, formatMinuteOfDay } from "./time";

export const metadata: Metadata = { title: "Hours" };

/**
 * Weekly windows, campus time. These are the only source of bookable times —
 * a tutor with no hours cannot be booked at all, however many students want
 * them — which is why this screen says so plainly rather than sitting empty.
 */
export default async function TutorAvailabilityPage() {
  const tutor = await requireTutor();
  const windows = await availabilityForTutor(tutor);

  const byDay = WEEKDAYS.map((day, weekday) => ({
    day,
    windows: windows.filter((window) => window.weekday === weekday),
  })).filter((group) => group.windows.length > 0);

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <PageHeader
        title="When you are free"
        description={`Recurring weekly. Students pick a ${SESSION_MINUTES}-minute slot out of these once you have accepted them, never at short notice.`}
      />

      {byDay.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No hours yet"
          description="Nobody can book you until there is somewhere to book. Add the times you are free below — everything else you have set up waits on this."
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Card padded={false}>
            <ul className="divide-y divide-border">
              {byDay.map((group) => (
                <li key={group.day} className="flex flex-col gap-2 p-4 sm:p-5">
                  <p className="text-sm font-medium text-foreground">{group.day}</p>
                  <ul className="flex flex-col">
                    {group.windows.map((window) => (
                      <li key={window.id}>
                        <WindowRow window={window} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </Card>
          <p className="text-sm text-muted">
            That is {slotsPerWeek(windows)} bookable sessions a week. Removing a
            window never cancels a session already booked out of it.
          </p>
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-4">
          <h2 className="text-base font-medium text-foreground">Add hours</h2>
          <AvailabilityForm />
        </div>
      </Card>
    </div>
  );
}

function WindowRow({ window }: { window: AvailabilityWindow }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-muted">
        {formatMinuteOfDay(window.startMinute)} – {formatMinuteOfDay(window.endMinute)}
      </span>
      {/* No confirmation step: the hours are back in two taps, and nothing
          already booked moves. */}
      <form action={removeAvailabilityAction}>
        <input type="hidden" name="windowId" value={window.id} />
        <Button type="submit" variant="ghost">
          Remove
        </Button>
      </form>
    </div>
  );
}
