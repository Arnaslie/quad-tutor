import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "drizzle/meta/_journal.json";
const { entries } = JSON.parse(readFileSync(path, "utf8"));

const problems = [];
entries.forEach((entry, i) => {
  if (entry.idx !== i) problems.push(`${entry.tag}: idx is ${entry.idx}, expected ${i}`);
  const prev = entries[i - 1];
  if (prev && !(entry.when > prev.when)) {
    problems.push(`${entry.tag}: when ${entry.when} is not after ${prev.tag} (${prev.when})`);
  }
});

if (problems.length) {
  console.error(`${path} is out of order; the migrator would skip these silently:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("Regenerate the migration on top of origin/main with `npm run db:generate`.");
  process.exit(1);
}
console.log(`${path}: ${entries.length} migrations in order.`);
