import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { formatMonthDay } from "@/components/format";
import { NAME_REQUIRED_MESSAGE } from "@/server/auth";
import { courseTicker, launchCampusId, type CourseTickerItem } from "@/server/modules/catalog/courses";
import { currentActor } from "@/server/modules/identity/actor";
import { CourseTicker, type TickerPill } from "./course-ticker";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN:
    "That sign-in link was already used or has expired. Each link works once — use the newest email, or send yourself a new one.",
  EXPIRED_TOKEN: "That sign-in link expired. Send yourself a new one.",

  [NAME_REQUIRED_MESSAGE]: NAME_REQUIRED_MESSAGE,
};

function toPill(item: CourseTickerItem): TickerPill {
  const tutors = `${item.tutorCount} ${item.tutorCount === 1 ? "tutor" : "tutors"}`;
  return {
    code: item.code,
    title: item.title,
    detail: item.nextExamOn ? `${tutors} · Exam ${formatMonthDay(item.nextExamOn)}` : tutors,
  };
}

export default async function SignInPage(props: PageProps<"/sign-in">) {
  if (await currentActor()) redirect("/courses");

  const { error } = await props.searchParams;
  const code = typeof error === "string" ? error : null;
  const message = code
    ? (LINK_ERRORS[code] ?? "That sign-in link did not work. Send yourself a new one.")
    : null;

  const campusId = await launchCampusId();
  const pills = campusId ? (await courseTicker(campusId)).map(toPill) : [];

  return (
    <div className="flex flex-col gap-6">
      {pills.length > 0 ? <CourseTicker pills={pills} /> : null}

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Quad Tutor</h1>
        <p className="text-base text-muted">
          Peer tutors who already took your course — under your professor.
        </p>
      </div>

      {message ? (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          {message}
        </p>
      ) : null}

      <SignInForm />
    </div>
  );
}
