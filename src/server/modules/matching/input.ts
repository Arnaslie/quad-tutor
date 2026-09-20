/**
 * Boundary schemas for the matching module, mirroring `engagements/input.ts`.
 *
 * No `tutorProfileId`, no `studentProfileId`, no `institutionId`:
 * `acceptRequest`, `declineRequest` and `requestTutors` all scope to the actor
 * they are handed, and a schema that accepted those ids would make the leak
 * look validated.
 */

import { z } from "zod";

export const requestRef = z.object({ requestId: z.uuid() });

export const acceptRequestInput = requestRef;
export const declineRequestInput = requestRef;

/**
 * Up to three parallel asks — the cap is enforced against the student's live
 * standing inside `requestTutors`, because a limit checked only in a schema is
 * a limit two browser tabs can walk past. This bound is just the shape.
 */
export const requestTutorsInput = z.object({
  courseOfferingId: z.uuid(),
  tutorCourseIds: z.array(z.uuid()).min(1).max(3),
});

export type AcceptRequestInput = z.infer<typeof acceptRequestInput>;
export type DeclineRequestInput = z.infer<typeof declineRequestInput>;
export type RequestTutorsInput = z.infer<typeof requestTutorsInput>;
