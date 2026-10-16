import { expect, test as base } from "@playwright/test";
import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { wipeTestRun } from "@/server/db/personas/wipe";
import { moveIntoPast } from "@/server/db/scenarios/sessions";
import { sessionBooking } from "@/server/db/schema";

import { env } from "./env";
import { newcomer, openAs, testCampus, tutorFor, type TestCampus } from "./people";

const EC110 = "EC 110";

const test = base.extend<{ campus: TestCampus }>({
  campus: async ({}, provide) => {
    const campus = await testCampus();
    await provide(campus);
    await wipeTestRun(campus);
  },
});

test("a new student books a tutor and both confirm the session", async ({ browser, campus }) => {
  const tutor = await tutorFor(campus, EC110);
  const student = await newcomer(campus, "student", "Student");

  const studentPage = await openAs(browser, student);
  await expect(studentPage).toHaveURL(/\/welcome$/);
  await expect(studentPage.getByRole("heading", { name: /^Welcome/ })).toContainText("Student");
  await studentPage.getByRole("link", { name: /I need help/ }).click();
  await expect(studentPage.getByRole("heading", { name: "What are you stuck in?" })).toBeVisible();

  await test.step("the student asks the tutor", async () => {
    await studentPage.getByRole("searchbox", { name: "Course" }).fill(EC110);
    await studentPage.waitForURL(/[?&]q=/);
    await studentPage.getByRole("link", { name: EC110 }).click();
    await studentPage.getByRole("link", { name: `${tutor.professor} Section ${tutor.section}` }).click();

    const name = studentPage.getByRole("heading", { name: tutor.name, level: 3 });
    const next = studentPage.getByRole("button", { name: "Next tutor" });
    await expect(name.or(next).first()).toBeVisible();
    while (!(await name.isVisible())) await next.click();

    const ask = studentPage.getByRole("button", { name: /^Ask( this tutor)?$/ });
    await studentPage.locator("div").filter({ has: name }).filter({ has: ask }).last().locator(ask).click();
    await studentPage.getByRole("button", { name: "Ask 1 tutor" }).click();
    await studentPage.waitForURL("**/requests");
    await expect(studentPage.getByRole("region", { name: "Waiting" }).getByText(tutor.name)).toBeVisible();
  });

  const tutorPage = await openAs(browser, tutor);

  await test.step("the tutor accepts", async () => {
    await tutorPage.goto("/tutor");
    const card = tutorPage.getByRole("listitem").filter({ has: tutorPage.getByRole("heading", { name: student.name }) });
    await card.getByRole("button", { name: "Accept" }).click();
    await expect(card.getByRole("status")).toContainText(`${student.name} picks a time`);
  });

  const sessionId = await test.step("the student pays through Checkout", async () => {
    await studentPage.goto("/requests");
    await expect(studentPage.getByText(`${tutor.name} said yes`)).toBeVisible();
    await studentPage.getByRole("link", { name: "Pick a time" }).click();
    await studentPage.getByRole("button", { name: /^Continue to payment/ }).click();
    await studentPage.getByRole("link", { name: "Pay", exact: true }).click();
    await expect(studentPage.getByText("Your package is paid for")).toBeVisible();

    const session = studentPage.getByRole("region", { name: "Coming up" }).getByRole("link").first();
    await expect(session).toContainText(`With ${tutor.name}`);
    await expect(session).toHaveAttribute("href", /^\/sessions\/[\w-]+$/);
    return (await session.getAttribute("href"))?.slice("/sessions/".length) ?? "";
  });

  await tutorPage.goto("/tutor/sessions");
  const booked = tutorPage.getByRole("listitem").filter({ hasText: student.name });
  await expect(booked).toContainText(EC110);
  await expect(booked.getByText("Did this session happen?")).toHaveCount(0);

  await test.step("both sides confirm attendance", async () => {
    const [{ engagementId }] = await db
      .select({ engagementId: sessionBooking.engagementId })
      .from(sessionBooking)
      .where(eq(sessionBooking.id, sessionId));
    await moveIntoPast({ engagementId, sessionId, hoursAgo: 2 });

    await studentPage.goto(`/sessions/${sessionId}`);
    await studentPage.getByRole("button", { name: "Yes, it happened" }).click();
    await expect(studentPage.getByText(`You said this happened. Waiting on ${tutor.name}.`)).toBeVisible();

    await tutorPage.goto("/tutor/sessions");
    const waiting = tutorPage.getByRole("listitem").filter({ hasText: student.name });
    await waiting.getByRole("button", { name: "It happened" }).click();
    await expect(waiting.getByText("Confirmed by both of you.")).toBeVisible();

    await studentPage.reload();
    await expect(studentPage.getByText("Both of you confirmed it")).toBeVisible();
    await tutorPage.reload();
    await expect(tutorPage.getByText(`Delivered. You and ${student.name} both confirmed it.`)).toBeVisible();
  });

  await test.step("the student books the next session and cancels it", async () => {
    await studentPage.goto("/sessions");
    await expect(studentPage.getByText("3 of 4 left to book")).toBeVisible();
    await studentPage.getByRole("link", { name: "Book the next one" }).click();
    await studentPage.getByRole("button", { name: /^Show all \d+ times$/ }).click();
    await studentPage.getByRole("group", { name: `When ${tutor.name} is free` }).getByRole("button").last().click();
    await studentPage.getByRole("button", { name: "Book this session" }).click();
    await expect(studentPage.getByRole("status")).toContainText(`confirmed on ${tutor.name}’s calendar`);

    await studentPage.getByRole("link", { name: "See your sessions" }).click();
    await expect(studentPage.getByText("2 of 4 left to book")).toBeVisible();
    await studentPage.getByRole("region", { name: "Coming up" }).getByRole("link").first().click();
    await studentPage.getByRole("button", { name: "Cancel this session" }).click();
    await studentPage.getByRole("button", { name: "Cancel it", exact: true }).click();
    await expect(studentPage.getByRole("definition").filter({ hasText: "Cancelled" })).toBeVisible();

    await studentPage.goto("/sessions");
    await expect(studentPage.getByText("3 of 4 left to book")).toBeVisible();
  });
});

test("a new user starts tutoring in one click", async ({ browser, campus }) => {
  const page = await openAs(browser, await newcomer(campus, "new-tutor", "Tutor"));
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByRole("button", { name: /I'm a tutor/ }).click();
  await page.waitForURL("**/tutor");
  await expect(page.getByRole("heading", { name: "Claim a course first" })).toBeVisible();
});

test("the scheduled sweep runs with the secret and refuses without it", async ({ request }) => {
  expect((await request.get("/api/cron")).status()).toBe(401);

  const response = await request.get("/api/cron", {
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true });
});
