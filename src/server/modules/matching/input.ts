import { z } from "zod";

export const requestRef = z.object({ requestId: z.uuid() });

export const acceptRequestInput = requestRef;
export const declineRequestInput = requestRef;

export const requestTutorsInput = z.object({
  courseOfferingId: z.uuid(),
  tutorCourseIds: z.array(z.uuid()).min(1).max(3),
});

export type AcceptRequestInput = z.infer<typeof acceptRequestInput>;
export type DeclineRequestInput = z.infer<typeof declineRequestInput>;
export type RequestTutorsInput = z.infer<typeof requestTutorsInput>;
