import { randomInt, randomUUID } from "node:crypto";

import { expect, type Browser, type Page } from "@playwright/test";
import { and, desc, eq, gt, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { verification } from "@/server/db/auth-schema";
import { personaEmail, type PersonaCampus } from "@/server/db/personas/people";
import { claimedTutor } from "@/server/db/personas/tutors";
import { institution, institutionEmail } from "@/server/db/schema";

import { env } from "./env";

export type Person = { name: string; email: string };

export const EC110 = { code: "EC 110", section: "001", professor: "Carla Nunez" };

export async function testCampus(): Promise<PersonaCampus> {
  const [campus] = await db.select({ id: institution.id }).from(institution).where(eq(institution.slug, "ua"));
  if (!campus) throw new Error('No campus "ua" — run npm run db:catalog first.');
  return { institutionId: campus.id, testRun: randomUUID().slice(0, 8) };
}

/** Allowed to sign in, but no account yet, so the first sign-in lands on /welcome. */
export async function newcomer(campus: PersonaCampus, key: string, name: string): Promise<Person> {
  const email = personaEmail(campus, key);
  await db.insert(institutionEmail).values({ email, institutionId: campus.institutionId });
  return { name: `${name} ${campus.testRun}`, email };
}

export async function tutorFor(campus: PersonaCampus, course: string): Promise<Person> {
  const name = `Tutor ${campus.testRun}`;
  const { tutor } = await claimedTutor(campus, {
    key: "tutor",
    name,
    headline: `${course} tutor`,
    course,
    rateDollars: 40,
    kyc: "not_started",
  });
  return { name, email: tutor.email };
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
        sql`${verification.value}::jsonb ->> 'name' = ${person.name}`,
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
