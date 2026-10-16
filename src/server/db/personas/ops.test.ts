import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { like } from "drizzle-orm";

import { db } from "../index";
import { verification } from "../schema";

import { cleanup, operator, person, run, world } from "@/server/modules/billing/test-world";
import type { OperatorActor } from "@/server/modules/identity/actor";

import { resetTestUsers, sendTestUserSignInLink, testUsersFor } from "./ops";
import { createPersona, createTutorPersona, personaEmail, type PersonaCampus } from "./people";
import { wipeTestRun } from "./wipe";

let ops: OperatorActor;
let away: OperatorActor;
let campus: Required<PersonaCampus>;
let awayCampus: Required<PersonaCampus>;
let realEmail: string;
const setting = process.env.TEST_PERSONAS;
const request = new Headers({ origin: "http://localhost:3000" });

before(async () => {
  const home = (await world("test_ops")).institutionId;
  const other = (await world("test_ops")).institutionId;
  ops = await operator(home);
  away = await operator(other);
  campus = { institutionId: home, testRun: run };
  awayCampus = { institutionId: other, testRun: `${run}a` };
  await createPersona(campus, "linkstudent", "Link Student");
  await createTutorPersona(campus, { key: "linktutor", name: "Link Tutor", headline: "Tutor", kyc: "verified" });
  await createPersona(awayCampus, "linkaway", "Link Away");
  realEmail = (await person(home, "test_ops")).email;
});

after(async () => {
  process.env.TEST_PERSONAS = setting;
  await db.delete(verification).where(like(verification.value, `%${run}%`));
  await wipeTestRun(campus);
  await wipeTestRun(awayCampus);
  await cleanup();
});

const linksFor = (email: string) => db.select().from(verification).where(like(verification.value, `%${email}%`));

test("only an operator can reset test users", async () => {
  process.env.TEST_PERSONAS = "on";
  assert.deepEqual(await resetTestUsers(null), {
    status: "refused",
    message: "Only an operator on this campus can reset test users.",
  });
  assert.deepEqual(await resetTestUsers({ ...ops, operatorInstitutionIds: [] }), {
    status: "refused",
    message: "Only an operator on this campus can reset test users.",
  });
});

test("an operator cannot reset test users while TEST_PERSONAS is not on", async () => {
  for (const value of [undefined, "", "off", "true"]) {
    if (value === undefined) delete process.env.TEST_PERSONAS;
    else process.env.TEST_PERSONAS = value;
    assert.deepEqual(await resetTestUsers(ops), { status: "refused", message: "Test users are turned off here." });
  }
});

test("an operator sees only the test users on their own campus", async () => {
  process.env.TEST_PERSONAS = "on";
  assert.deepEqual(await testUsersFor(ops), [
    { email: personaEmail(campus, "linkstudent"), role: "student" },
    { email: personaEmail(campus, "linktutor"), role: "tutor" },
  ]);
  assert.deepEqual(await testUsersFor(null), []);
});

test("an operator sends a sign-in link to a test user on their campus", async () => {
  process.env.TEST_PERSONAS = "on";
  const email = personaEmail(campus, "linktutor");
  assert.deepEqual(await sendTestUserSignInLink(ops, email.toUpperCase(), request), { status: "sent" });
  assert.equal((await linksFor(email)).length, 1);
});

test("no sign-in link goes to a real user, another campus's test user, or from a non-operator", async () => {
  process.env.TEST_PERSONAS = "on";
  const notTestUser = { status: "refused", message: "That is not a test user on your campus." };
  assert.deepEqual(await sendTestUserSignInLink(ops, realEmail, request), notTestUser);
  assert.deepEqual(await sendTestUserSignInLink(ops, personaEmail(awayCampus, "linkaway"), request), notTestUser);
  assert.deepEqual(await sendTestUserSignInLink(away, personaEmail(campus, "linkstudent"), request), notTestUser);
  assert.deepEqual(await sendTestUserSignInLink(null, personaEmail(campus, "linkstudent"), request), {
    status: "refused",
    message: "Only an operator on this campus can send sign-in links to test users.",
  });
  process.env.TEST_PERSONAS = "off";
  assert.deepEqual(await sendTestUserSignInLink(ops, personaEmail(campus, "linkstudent"), request), {
    status: "refused",
    message: "Test users are turned off here.",
  });
  assert.equal((await linksFor(realEmail)).length, 0);
  assert.equal((await linksFor(personaEmail(campus, "linkstudent"))).length, 0);
  assert.equal((await linksFor(personaEmail(awayCampus, "linkaway"))).length, 0);
});
