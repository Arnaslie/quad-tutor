/** Message bodies. Pure. Each one states the deadline it exists to prevent. */

import { formatDayTime } from "@/components/format";

import type { Email } from "./email";

const SIGN_OFF = ["", "— Quad Tutor"];

function url(path: string): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return `${base}${path}`;
}

/** Tutor: a request is waiting. */
export function requestWaiting(params: {
  to: string;
  tutorName: string;
  studentName: string;
  courseLabel: string;
  expiresAt: Date;
}): Email {
  return {
    to: params.to,
    subject: `${params.studentName} asked you for help with ${params.courseLabel}`,
    text: [
      `${params.tutorName},`,
      "",
      `${params.studentName} is looking for help with ${params.courseLabel} and asked you.`,
      "",
      `Answer by ${formatDayTime(params.expiresAt)}.`,
      "",
      "Passing costs you nothing — say no and the request goes back to them",
      "straight away. Letting it run out is the only answer that counts against",
      "you, and they are left waiting either way.",
      "",
      url("/tutor"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

/** Student: accepted, now pick a time. */
export function requestAccepted(params: {
  to: string;
  studentName: string;
  tutorName: string;
  courseLabel: string;
}): Email {
  return {
    to: params.to,
    subject: `${params.tutorName} can help with ${params.courseLabel}`,
    text: [
      `${params.studentName},`,
      "",
      `${params.tutorName} said yes to ${params.courseLabel}.`,
      "",
      "Pick a package and a time to lock it in. Nothing is charged until you do.",
      "",
      url("/requests"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

/** Booked. Carries the free-cancel deadline for sessions booked inside 24h. */
export function sessionBooked(params: {
  to: string;
  name: string;
  otherPartyName: string;
  courseLabel: string;
  scheduledAt: Date;
  freeUntil: Date;
  locationNote: string | null;
}): Email {
  return {
    to: params.to,
    subject: `Booked: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.courseLabel} with ${params.otherPartyName}`,
      formatDayTime(params.scheduledAt),
      params.locationNote ? params.locationNote : "You two agree where to meet.",
      "",
      `Cancelling is free until ${formatDayTime(params.freeUntil)}. After that it`,
      "counts as a late cancel.",
      "",
      url("/sessions"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

/** T-24h nudge. */
export function sessionTomorrow(params: {
  to: string;
  name: string;
  otherPartyName: string;
  courseLabel: string;
  scheduledAt: Date;
  freeUntil: Date;
}): Email {
  return {
    to: params.to,
    subject: `Tomorrow: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.courseLabel} with ${params.otherPartyName} is ${formatDayTime(params.scheduledAt)}.`,
      "",
      `Can't make it? Cancelling is free until ${formatDayTime(params.freeUntil)} —`,
      "after that it counts as a late cancel.",
      "",
      url("/sessions"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}
