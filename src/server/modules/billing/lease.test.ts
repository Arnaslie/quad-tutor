import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "@/server/db";
import { isLocalHost } from "@/server/db/local-host.mjs";
import { institution, sweepLease } from "@/server/db/schema";

import { claim, release, withLease } from "./lease";

const databaseHost = new URL(process.env.DATABASE_URL ?? "postgres://unset").hostname;
if (!isLocalHost(databaseHost)) {
  throw new Error(`Refusing to run tests against ${databaseHost}: point DATABASE_URL at a local database.`);
}

const HOUR_MS = 3_600_000;
const run = randomUUID().slice(0, 8);
let home: string;

before(async () => {
  const [row] = await db
    .insert(institution)
    .values({ name: "Test lease", slug: `lease-${run}`, emailDomain: `lease-${run}.test`, timezone: "America/Chicago" })
    .returning({ id: institution.id });
  home = row.id;
});

after(async () => {
  await db.delete(sweepLease).where(eq(sweepLease.institutionId, home));
  await db.delete(institution).where(eq(institution.id, home));
  await db.$client.end();
});

test("a held lease turns the next claim away, and releasing it lets the next claim in at once", async () => {
  const held = await claim(home, "released", HOUR_MS);
  assert.ok(held);
  assert.equal(await claim(home, "released", HOUR_MS), null);

  await release(home, "released", held);
  assert.ok(await claim(home, "released", HOUR_MS), "claimable again without waiting out the hour");
});

test("withLease frees the lease when the work ends", async () => {
  assert.equal(await withLease(home, "scoped", HOUR_MS, async () => "done"), "done");
  assert.equal(await withLease(home, "scoped", HOUR_MS, async () => "again"), "again");
});

test("a lease lasts its ttl on the database's clock when the app server's clock runs an hour behind", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - HOUR_MS });
  assert.ok(await claim(home, "slow-clock", 60_000));
  assert.equal(await claim(home, "slow-clock", 60_000), null);
});

test("a lapsed lease is claimable when the app server's clock runs an hour ahead", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + HOUR_MS });
  assert.ok(await claim(home, "fast-clock", 1));
  await sleep(10);
  assert.ok(await claim(home, "fast-clock", 1));
});
