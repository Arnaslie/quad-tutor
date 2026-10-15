import { db } from "../index";

import { campusBySlug } from "./people";
import { resetPersonas } from "./reset";

const CAMPUS_SLUG = "ua";

async function main(): Promise<void> {
  const built = await resetPersonas(await campusBySlug(CAMPUS_SLUG));
  console.log(`\nreset ${built.length} personas on ${CAMPUS_SLUG}\n`);
  for (const persona of built) {
    console.log(`  ${persona.key.padEnd(22)} ${persona.email.padEnd(48)} ${persona.role}: ${persona.state}`);
  }
}

main()
  .then(() => db.$client.end())
  .catch(async (error) => {
    console.error(error);
    await db.$client.end();
    process.exitCode = 1;
  });
