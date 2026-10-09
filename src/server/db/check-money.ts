import { db } from "./index";
import { institution } from "./schema";

import { checkMoneyInvariants } from "@/server/modules/billing/invariants";

async function main(): Promise<void> {
  const campuses = await db.select({ id: institution.id, slug: institution.slug }).from(institution);
  let broken = 0;

  for (const campus of campuses) {
    const found = await checkMoneyInvariants(campus.id);
    broken += found.length;
    console.log(`${campus.slug}: ${found.length === 0 ? "ok" : `${found.length} broken`}`);
    for (const v of found) console.log(`  ${v.invariant}: ${v.subject} (${v.detail})`);
  }

  if (broken > 0) process.exitCode = 1;
}

main()
  .then(() => db.$client.end())
  .catch(async (error) => {
    console.error(error);
    await db.$client.end();
    process.exitCode = 1;
  });
