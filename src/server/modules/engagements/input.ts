import { z } from "zod";

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

export const purchaseTopUpInput = z.object({
  engagementId: z.uuid(),

  slotStartsAt: z.coerce.date(),
});

export const bookSessionInput = z.object({
  engagementId: z.uuid(),

  slotStartsAt: z.coerce.date(),
  locationNote: z.string().trim().max(200).optional(),
});

/** Back office only — see the TODO(admin) note on `resolveDispute`. */
export const resolveDisputeInput = sessionRef.extend({
  attended: z.boolean(),
  studentNoShowed: z.boolean().optional(),
});

export type SlotsForRequestInput = z.infer<typeof slotsForRequestInput>;
export type SlotsForEngagementInput = z.infer<typeof slotsForEngagementInput>;
export type SlotsForTopUpInput = z.infer<typeof slotsForTopUpInput>;
export type PurchaseTopUpInput = z.infer<typeof purchaseTopUpInput>;
export type ConfirmAttendanceInput = z.infer<typeof confirmAttendanceInput>;
export type DenyAttendanceInput = z.infer<typeof denyAttendanceInput>;
export type CancelSessionInput = z.infer<typeof cancelSessionInput>;
export type BookSessionInput = z.infer<typeof bookSessionInput>;
export type ResolveDisputeInput = z.infer<typeof resolveDisputeInput>;
