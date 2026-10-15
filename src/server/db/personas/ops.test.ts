import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { cleanup, operator, world } from "@/server/modules/billing/test-world";
import type { OperatorActor } from "@/server/modules/identity/actor";

import { resetTestUsers } from "./ops";

let ops: OperatorActor;
const setting = process.env.TEST_PERSONAS;

before(async () => {
  ops = await operator((await world("test_ops")).institutionId);
});

after(async () => {
  process.env.TEST_PERSONAS = setting;
  await cleanup();
});

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
