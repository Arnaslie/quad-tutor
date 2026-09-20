/**
 * The boundary schemas for everything in this module that a browser can call.
 *
 * The functions themselves take typed arguments and trust them — by the time a
 * `sessionId` reaches `confirmAttendance` it is authorised against the actor,
 * which is a stronger check than any shape validation. What these are for is
 * the layer above: a server action receives `FormData` and untyped JSON, and
 * this is where that becomes a `Date` and a uuid rather than whatever was
 * posted.
 *
 * Note what is *not* here: `institutionId`, `studentProfileId`,
 * `tutorProfileId`. The tenant key and the caller's identity come from the
 * session via `requireActor()`, never from the request body. A schema that
 * accepted them would make the leak look validated.
 */

import { z } from "zod";

export const sessionRef = z.object({
  sessionId: z.uuid(),
});

export const confirmAttendanceInput = sessionRef;
export const cancelSessionInput = sessionRef;

export const denyAttendanceInput = sessionRef.extend({
  /** What the human reviewing a dispute reads. Short on purpose. */
  note: z.string().trim().max(500).optional(),
});

/** For the reads that resolve a tutor or a package from an id the caller holds. */
export const requestRef = z.object({ requestId: z.uuid() });
export const engagementRef = z.object({ engagementId: z.uuid() });

export const slotsForRequestInput = requestRef;
export const slotsForEngagementInput = engagementRef;
/** The finished package a top-up is bought against, not a new relationship. */
export const slotsForTopUpInput = engagementRef;

export const purchaseTopUpInput = z.object({
  engagementId: z.uuid(),
  /** Must be one of the slots `slotsForTopUp` offered; checked there. */
  slotStartsAt: z.coerce.date(),
});

export const bookSessionInput = z.object({
  engagementId: z.uuid(),
  /** Must be one of the slots `availableSlots` offered; checked there, not here. */
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
