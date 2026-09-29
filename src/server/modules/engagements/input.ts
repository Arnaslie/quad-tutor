import { z } from "zod";

import { meetingLocation } from "@/server/modules/tutoring/input";

export const sessionRef = z.object({
  sessionId: z.uuid(),
});

export const confirmAttendanceInput = sessionRef;
export const cancelSessionInput = sessionRef;

export const denyAttendanceInput = sessionRef.extend({
  note: z.string().trim().max(500).optional(),
});

export const requestRef = z.object({ requestId: z.uuid() });
export const engagementRef = z.object({ engagementId: z.uuid() });

export const slotsForRequestInput = requestRef;
export const slotsForEngagementInput = engagementRef;

export const slotsForTopUpInput = engagementRef;

export const studentNote = z.string().trim().max(200).optional();

export const engagementSlotInput = z.object({
  engagementId: z.uuid(),

  slotStartsAt: z.coerce.date(),
  studentNote,
});

export const setSessionLocationInput = sessionRef.extend({ location: meetingLocation });

/** Back office only — see the TODO(admin) note on `resolveDispute`. */
export const resolveDisputeInput = sessionRef.extend({
  attended: z.boolean(),
  studentNoShowed: z.boolean().optional(),
});

export type SlotsForRequestInput = z.infer<typeof slotsForRequestInput>;
export type SlotsForEngagementInput = z.infer<typeof slotsForEngagementInput>;
export type SlotsForTopUpInput = z.infer<typeof slotsForTopUpInput>;
export type EngagementSlotInput = z.infer<typeof engagementSlotInput>;
export type ConfirmAttendanceInput = z.infer<typeof confirmAttendanceInput>;
export type DenyAttendanceInput = z.infer<typeof denyAttendanceInput>;
export type CancelSessionInput = z.infer<typeof cancelSessionInput>;
export type SetSessionLocationInput = z.infer<typeof setSessionLocationInput>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeInput>;
