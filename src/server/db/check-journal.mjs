import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "drizzle/meta/_journal.json";

let entries;
try {
  ({ entries } = JSON.parse(readFileSync(path, "utf8")));
} catch (e) {
  console.error(`${path}: cannot read journal (${e.code ?? e.message}).`);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error(`${path}: journal has no entries array.`);
  process.exit(1);
}

const skipped = [];
const malformed = [];
entries.forEach((entry, i) => {
  const prev = entries[i - 1];
  const expected = prev ? prev.idx + 1 : 0;
  if (entry.idx !== expected) malformed.push(`${entry.tag}: idx is ${entry.idx}, expected ${expected}`);
  if (prev && !(entry.when > prev.when)) {
    skipped.push(`${entry.tag}: when ${entry.when} is not after ${prev.tag} (${prev.when})`);
  }
});

if (skipped.length || malformed.length) {
  console.error(`${path} failed the migration journal check.`);
  if (skipped.length) console.error(["Would be skipped by the migrator:", ...skipped].join("\n  "));
  if (malformed.length) console.error(["Journal is malformed:", ...malformed].join("\n  "));
  console.error("Regenerate the migration on top of origin/main with `npm run db:generate`.");
  process.exit(1);
}
console.log(`${path}: ${entries.length} migrations in order.`);
