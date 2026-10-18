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
import { expandSlots } from "./slot-times";

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

  const timeZone = campus.at(0)?.timezone;
  if (windows.length === 0 || !timeZone) return [];

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

  return expandSlots({
    windows,
    timeZone,
    now: new Date(),
    taken: new Set(booked.map((row) => row.scheduledAt.getTime())),
  });
}

export async function lockTutor(exec: Executor, tutorProfileId: string): Promise<void> {
  await exec
    .select({ id: tutorProfile.id })
    .from(tutorProfile)
    .where(eq(tutorProfile.id, tutorProfileId))
    .for("no key update");
}

/** The caller must already hold `lockTutor` for this tutor, or two bookings can take one slot. */
export async function slotOpen(
  exec: Executor,
  params: { tutorProfileId: string; institutionId: string; slotStartsAt: Date },
): Promise<boolean> {
  const open = await availableSlots({ ...params, exec });
  const wanted = params.slotStartsAt.getTime();
  return open.some((slot) => slot.getTime() === wanted);
}

export function confirmationDeadline(scheduledAt: Date): Date {
  return new Date(scheduledAt.getTime() + (SESSION_MINUTES + 24 * 60) * 60 * 1000);
}
