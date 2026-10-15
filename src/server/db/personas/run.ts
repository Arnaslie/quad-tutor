import { eq } from "drizzle-orm";

import { db } from "../index";
import { institution } from "../schema";

import { resetPersonas } from "./reset";

const CAMPUS_SLUG = "ua";

async function main(): Promise<void> {
  const [campus] = await db.select({ id: institution.id }).from(institution).where(eq(institution.slug, CAMPUS_SLUG));
  if (!campus) throw new Error(`No campus "${CAMPUS_SLUG}" — run npm run db:catalog first.`);

  const built = await resetPersonas({ institutionId: campus.id });
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
