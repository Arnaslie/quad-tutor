import { formatDayTime } from "@/components/format";

import { packageSummary, type RequestedKind } from "@/server/modules/billing/pricing";
import { lapseCopy } from "@/server/modules/engagements/answer-outcome";

import type { Email } from "./email";

const SIGN_OFF = ["", "— Quad Tutor"];

function url(path: string): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return `${base}${path}`;
}

export function requestWaiting(params: {
  to: string;
  tutorName: string;
  studentName: string;
  courseLabel: string;
  requestedKind: RequestedKind | null;
  expiresAt: Date;
}): Email {
  return {
    to: params.to,
    subject: `${params.studentName} asked you for help with ${params.courseLabel}`,
    text: [
      `${params.tutorName},`,
      "",
      `${params.studentName} is looking for help with ${params.courseLabel} and asked you.`,
      ...(params.requestedKind
        ? [`They asked for ${packageSummary(params.requestedKind)}.`]
        : []),
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

export function sectionCovered(params: {
  to: string;
  studentName: string;
  courseLabel: string;
  offeringId: string;
}): Email {
  return {
    to: params.to,
    subject: `Someone tutors ${params.courseLabel} now`,
    text: [
      `${params.studentName},`,
      "",
      `You asked us to tell you when someone covers ${params.courseLabel}. Someone does now.`,
      "",
      "See who took it and ask them straight away — the sooner you ask, the more",
      "sessions fit before your next exam.",
      "",
      url(`/courses/${params.offeringId}`),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function sessionBooked(params: {
  to: string;
  name: string;
  otherPartyName: string;
  courseLabel: string;
  scheduledAt: Date;
  freeUntil: Date;
  recipient: "student" | "tutor";
  location: string | null;
  studentNote: string | null;
}): Email {
  return {
    to: params.to,
    subject: `Booked: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.courseLabel} with ${params.otherPartyName}`,
      formatDayTime(params.scheduledAt),
      ...whereLines(params),
      "",
      `Cancelling is free until ${formatDayTime(params.freeUntil)}. After that it`,
      "counts as a late cancel.",
      "",
      url("/sessions"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

function whereLines(params: {
  otherPartyName: string;
  recipient: "student" | "tutor";
  location: string | null;
  studentNote: string | null;
}): string[] {
  const where = params.location
    ? [`Where: ${params.location}`]
    : params.recipient === "tutor"
      ? [`You have not set where you meet yet. Set it here: ${url("/tutor/availability")}`]
      : [`${params.otherPartyName} has not set where you meet yet. It will be on your session page once they do.`];

  return params.recipient === "tutor" && params.studentNote
    ? [...where, `Note from ${params.otherPartyName}: ${params.studentNote}`]
    : where;
}

export function sessionMoved(params: {
  to: string;
  name: string;
  otherPartyName: string;
  courseLabel: string;
  scheduledAt: Date;
  location: string;
  firstSpot: boolean;
  sessionId: string;
}): Email {
  return {
    to: params.to,
    subject: `${params.firstSpot ? "Spot set" : "New spot"}: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.otherPartyName} ${params.firstSpot ? "set" : "changed"} where you meet for ${params.courseLabel}`,
      `on ${formatDayTime(params.scheduledAt)}.`,
      "",
      `Where: ${params.location}`,
      "",
      url(`/sessions/${params.sessionId}`),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function sessionTomorrow(params: {
  to: string;
  name: string;
  otherPartyName: string;
  courseLabel: string;
  scheduledAt: Date;
  freeUntil: Date;
  recipient: "student" | "tutor";
  location: string | null;
  studentNote: string | null;
}): Email {
  return {
    to: params.to,
    subject: `Tomorrow: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.courseLabel} with ${params.otherPartyName} is ${formatDayTime(params.scheduledAt)}.`,
      ...whereLines(params),
      "",
      `Can't make it? Cancelling is free until ${formatDayTime(params.freeUntil)} —`,
      "after that it counts as a late cancel.",
      "",
      url("/sessions"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function claimVerified(params: {
  to: string;
  tutorName: string;
  courseLabel: string;
}): Email {
  return {
    to: params.to,
    subject: `${params.courseLabel} is live`,
    text: [
      `${params.tutorName},`,
      "",
      `Your transcript checked out, so ${params.courseLabel} is live. Students in the`,
      "course can see you and ask you for help from now on.",
      "",
      "We deleted the file you sent once it was checked.",
      "",
      url("/tutor/courses"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function messageWaiting(params: {
  to: string;
  recipientName: string;
  senderName: string;
  courseLabel: string;
  preview: string;
  threadId: string;
}): Email {
  return {
    to: params.to,
    subject: `${params.senderName} sent you a message about ${params.courseLabel}`,
    text: [
      `${params.recipientName},`,
      "",
      `${params.senderName} wrote:`,
      `"${params.preview}"`,
      "",
      "Read and reply here. We will not email about this conversation again until",
      "you have read it.",
      "",
      url(`/messages/${params.threadId}`),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function claimNeedsNewProof(params: {
  to: string;
  tutorName: string;
  courseLabel: string;
  reason: string;
}): Email {
  return {
    to: params.to,
    subject: `${params.courseLabel}: we need another copy of your transcript`,
    text: [
      `${params.tutorName},`,
      "",
      `We couldn't confirm ${params.courseLabel} from the file you sent.`,
      "",
      params.reason,
      "",
      "This is about the paperwork, nothing else. Upload a new copy and it goes",
      "straight back in the queue. We deleted the file you sent.",
      "",
      url("/tutor/courses"),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

type SessionEmail = {
  to: string;
  name: string;
  otherPartyName: string;
  courseLabel: string;
  scheduledAt: Date;
  recipient: "student" | "tutor";
  sessionId: string;
};

function sessionUrl(params: Pick<SessionEmail, "recipient" | "sessionId">): string {
  return params.recipient === "tutor"
    ? url("/tutor/sessions")
    : url(`/sessions/${params.sessionId}`);
}

export function sessionCancelled(params: SessionEmail): Email {
  return {
    to: params.to,
    subject: `Cancelled: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.otherPartyName} cancelled ${params.courseLabel} on ${formatDayTime(params.scheduledAt)}.`,
      "",
      params.recipient === "student"
        ? "The session is back in your package. Book another time whenever suits you."
        : `That time is open again, and the session is back in ${params.otherPartyName}'s package.`,
      "",
      sessionUrl(params),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export function answerDue(
  params: SessionEmail & { answerBy: Date; otherAnswered: boolean; deliveredIfUnanswered: boolean },
): Email {
  const packageOwner = params.recipient === "student" ? "your" : `${params.otherPartyName}'s`;
  return {
    to: params.to,
    subject: `Did ${params.courseLabel} with ${params.otherPartyName} happen?`,
    text: [
      `${params.name},`,
      "",
      `${params.courseLabel} with ${params.otherPartyName} on ${formatDayTime(params.scheduledAt)} has finished.`,
      `${params.otherAnswered ? "Tell us" : "You both answer"} whether it happened. Answer by ${formatDayTime(params.answerBy)}.`,
      "",
      `If you don't answer by then, ${lapseCopy(params.deliveredIfUnanswered, packageOwner)}.`,
      "",
      sessionUrl(params),
      ...SIGN_OFF,
    ].join("\n"),
  };
}

export type SettledResolution =
  | "both_confirmed"
  | "auto_released"
  | "disputed"
  | "resolved_attended"
  | "resolved_not_attended";

function settledCopy(
  resolution: SettledResolution,
  params: SessionEmail,
): { label: string; line: string } {
  switch (resolution) {
    case "both_confirmed":
      return {
        label: "Confirmed",
        line: `You and ${params.otherPartyName} both confirmed it happened. It is settled.`,
      };
    case "auto_released":
      return { label: "Settled", line: "The answer window closed, so it counts as delivered." };
    case "disputed":
      return {
        label: "Under review",
        line: `You and ${params.otherPartyName} answered differently. A person settles it, and no money moves until then.`,
      };
    case "resolved_attended":
      return { label: "Settled", line: "It settled as attended." };
    case "resolved_not_attended":
      return {
        label: "Settled",
        line: `It settled as not happening. The session went back into ${
          params.recipient === "student" ? "your" : `${params.otherPartyName}'s`
        } package.`,
      };
  }
}

export function sessionSettled(
  params: SessionEmail & { resolution: SettledResolution },
): Email {
  const { label, line } = settledCopy(params.resolution, params);
  return {
    to: params.to,
    subject: `${label}: ${params.courseLabel} with ${params.otherPartyName}`,
    text: [
      `${params.name},`,
      "",
      `${params.courseLabel} with ${params.otherPartyName} on ${formatDayTime(params.scheduledAt)}:`,
      line,
      "",
      sessionUrl(params),
      ...SIGN_OFF,
    ].join("\n"),
  };
}
