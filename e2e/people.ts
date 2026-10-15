import { randomInt, randomUUID } from "node:crypto";

import { expect, type Browser, type Page } from "@playwright/test";
import { and, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { verification } from "@/server/db/auth-schema";
import { campusBySlug, personaEmail, type PersonaCampus } from "@/server/db/personas/people";
import { claimedTutor } from "@/server/db/personas/tutors";
import { courseOffering, institutionEmail, professor } from "@/server/db/schema";

import { env } from "./env";

export type Person = { name: string; email: string };

export type TestCampus = Required<PersonaCampus>;

export async function testCampus(): Promise<TestCampus> {
  return { ...(await campusBySlug("ua")), testRun: randomUUID().slice(0, 8) };
}

/** Allowed to sign in, but no account yet, so the first sign-in lands on /welcome. */
export async function newcomer(campus: TestCampus, key: string, name: string): Promise<Person> {
  const email = personaEmail(campus, key);
  await db.insert(institutionEmail).values({ email, institutionId: campus.institutionId });
  return { name: `${name} ${campus.testRun}`, email };
}

export async function tutorFor(
  campus: TestCampus,
  course: string,
): Promise<Person & { section: string; professor: string }> {
  const name = `Tutor ${campus.testRun}`;
  const { tutor, target } = await claimedTutor(campus, {
    key: "tutor",
    name,
    headline: `${course} tutor`,
    course,
    rateDollars: 40,
    kyc: "not_started",
  });
  const [offering] = await db
    .select({ section: courseOffering.section, professor: professor.name })
    .from(courseOffering)
    .innerJoin(professor, eq(professor.id, courseOffering.professorId))
    .where(eq(courseOffering.id, target.courseOfferingId));
  if (!offering?.section) throw new Error(`${course}: the claimed offering has no section`);
  return { name, email: tutor.email, section: offering.section, professor: offering.professor };
}

// Better Auth's magic-link plugin stores the token plain in `identifier` and the
// `{ email, name }` sent with the request as JSON in `value`.
async function latestSignInToken(person: Person): Promise<string> {
  const [row] = await db
    .select({ token: verification.identifier })
    .from(verification)
    .where(
      and(
        sql`${verification.value}::jsonb ->> 'email' = ${person.email}`,
        gt(verification.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(verification.createdAt))
    .limit(1);
  if (!row) throw new Error(`no live sign-in token for ${person.email}`);
  return row.token;
}

// Better Auth rate-limits sign-in per client IP. Each person gets their own,
// as they would on their own phone.
export async function openAs(browser: Browser, person: Person): Promise<Page> {
  const context = await browser.newContext({
    baseURL: env.BETTER_AUTH_URL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: {
      "x-forwarded-for": `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`,
    },
  });
  const page = await context.newPage();

  await page.goto("/sign-in");
  await page.getByLabel("Your name").fill(person.name);
  await page.getByLabel("University email").fill(person.email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const params = new URLSearchParams({
    token: await latestSignInToken(person),
    callbackURL: "/courses",
    newUserCallbackURL: "/welcome",
    errorCallbackURL: "/sign-in",
  });
  await page.goto(`/sign-in/verify?${params}`);
  await page.getByRole("button", { name: "Continue to Quad Tutor" }).click();
  await page.waitForURL((url) => url.pathname === "/courses" || url.pathname === "/welcome");
  return page;
}
