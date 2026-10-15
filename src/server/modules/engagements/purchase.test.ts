import assert from "node:assert/strict";
import { after, test } from "node:test";

import { accepted, cleanup, world } from "@/server/modules/billing/test-world";

after(cleanup);

test("ten students buying the same tutor's first open time at once get it once between them", async () => {
  const w = await world();
  const students = [];
  for (let i = 0; i < 10; i += 1) students.push(await accepted(w));

  const results = await Promise.allSettled(students.map((student) => student.buy()));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(
    [...new Set(results.flatMap((result) => (result.status === "rejected" ? [(result.reason as Error).message] : [])))],
    ["That time is no longer available."],
  );
});
