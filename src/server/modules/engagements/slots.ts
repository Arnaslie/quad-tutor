import { and, eq, gte, ne } from "drizzle-orm";

import { db } from "@/server/db";
import {
  engagement,
  institution,
  sessionBooking,
  tutorAvailability,
  tutorCourse,
  tutorProfile,
} from "@/server/db/schema";

import type { Executor } from "./access";
import { SESSION_MINUTES } from "./attendance";

const MIN_LEAD_HOURS = 12;
const SLOT_HORIZON_DAYS = 14;

export async function availableSlots(params: {
  tutorProfileId: string;
  institutionId: string;
  exec?: Executor;
}): Promise<Date[]> {
  const exec = params.exec ?? db;
  const [windows, campus] = await Promise.all([
    exec
      .select({
        weekday: tutorAvailability.weekday,
        startMinute: tutorAvailability.startMinute,
        endMinute: tutorAvailability.endMinute,
      })
      .from(tutorAvailability)
      .where(
        and(
          eq(tutorAvailability.tutorProfileId, params.tutorProfileId),
          eq(tutorAvailability.institutionId, params.institutionId),
        ),
      ),
    exec
      .select({ timezone: institution.timezone })
      .from(institution)
      .where(eq(institution.id, params.institutionId))
      .limit(1),
  ]);

  if (windows.length === 0 || !campus.at(0)) return [];

  const booked = await exec
    .select({ scheduledAt: sessionBooking.scheduledAt })
    .from(sessionBooking)
    .innerJoin(engagement, eq(engagement.id, sessionBooking.engagementId))
    .innerJoin(tutorCourse, eq(tutorCourse.id, engagement.tutorCourseId))
    .where(
      and(
        eq(tutorCourse.tutorProfileId, params.tutorProfileId),
        ne(sessionBooking.status, "cancelled"),
        gte(sessionBooking.scheduledAt, new Date()),
      ),
    );

  const taken = new Set(booked.map((row) => row.scheduledAt.getTime()));
  const earliest = Date.now() + MIN_LEAD_HOURS * 60 * 60 * 1000;
  const slots: Date[] = [];

  for (let dayOffset = 0; dayOffset < SLOT_HORIZON_DAYS; dayOffset += 1) {
    const day = new Date();
    day.setDate(day.getDate() + dayOffset);
    day.setHours(0, 0, 0, 0);

    for (const window of windows) {
      if (window.weekday !== day.getDay()) continue;

      for (
        let minute = window.startMinute;
        minute + SESSION_MINUTES <= window.endMinute;
        minute += SESSION_MINUTES
      ) {
        const slot = new Date(day);
        slot.setMinutes(minute);
        if (slot.getTime() < earliest) continue;
        if (taken.has(slot.getTime())) continue;
        slots.push(slot);
      }
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}

export async function lockTutor(exec: Executor, tutorProfileId: string): Promise<void> {
  await exec
    .select({ id: tutorProfile.id })
    .from(tutorProfile)
    .where(eq(tutorProfile.id, tutorProfileId))
    .for("no key update");
}

/** Takes the tutor lock, so call it before any session lock in the same transaction. */
export async function holdSlot(
  exec: Executor,
  params: { tutorProfileId: string; institutionId: string; slotStartsAt: Date },
): Promise<boolean> {
  await lockTutor(exec, params.tutorProfileId);
  const open = await availableSlots({ ...params, exec });
  const wanted = params.slotStartsAt.getTime();
  return open.some((slot) => slot.getTime() === wanted);
}

export function confirmationDeadline(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() + (SESSION_MINUTES + 24 * 60) * 60 * 1000);
}
