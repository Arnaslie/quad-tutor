import { z } from "zod";

import { REQUESTABLE_KINDS } from "@/server/modules/billing/pricing";

export const requestRef = z.object({ requestId: z.uuid() });

export const acceptRequestInput = requestRef;
export const declineRequestInput = requestRef;

export const requestedKind = z.enum(REQUESTABLE_KINDS);

export const requestTutorsInput = z.object({
  courseOfferingId: z.uuid(),
  tutorCourseIds: z.array(z.uuid()).min(1).max(3),
  kind: requestedKind.default("exam_anchored"),
});

export const requestRenewalInput = z.object({
  tutorCourseId: z.uuid(),
  kind: requestedKind,
});

export type AcceptRequestInput = z.infer<typeof acceptRequestInput>;
export type DeclineRequestInput = z.infer<typeof declineRequestInput>;
export type RequestTutorsInput = z.infer<typeof requestTutorsInput>;
export type RequestRenewalInput = z.infer<typeof requestRenewalInput>;
