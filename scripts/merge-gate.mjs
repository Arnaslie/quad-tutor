import { execFileSync } from "node:child_process";

const USER_ONLY = [
  [/^drizzle\//, "database migration"],
  [/^drizzle\.config\.ts$/, "database migration"],
  [/^src\/server\/db\/(auth-)?schema\.ts$/, "database schema"],
  [/^\.github\/workflows\//, "deploy, migrate or cron workflow"],
  [/^\.env/, "environment settings"],
  [/^src\/server\/modules\/billing\/stripe\.ts$/, "Stripe keys and gateway settings"],
  [/^src\/server\/modules\/billing\/pricing\.ts$/, "prices, fees and take cap"],
];
const SETTINGS_IN_DIFF = /sk_live_|STRIPE_[A-Z_]+|livemode/;

const ref = process.argv[2];
if (!ref) {
  console.error("usage: npm run merge-gate -- <branch or PR number>");
  process.exit(2);
}
const head = /^\d+$/.test(ref)
  ? execFileSync("gh", ["pr", "view", ref, "--json", "headRefName", "--jq", ".headRefName"], { encoding: "utf8" }).trim()
  : ref;

try {
  execFileSync("git", ["fetch", "-q", "origin", "main", head], { stdio: "pipe" });
} catch {
  console.error(`${head} is not on origin; push it first`);
  process.exit(2);
}
const range = `origin/main...origin/${head}`;
const files = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" }).split("\n").filter(Boolean);
const added = execFileSync("git", ["diff", "-U0", range], { encoding: "utf8" })
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"));

const reasons = new Set();
for (const file of files) {
  for (const [pattern, reason] of USER_ONLY) if (pattern.test(file)) reasons.add(`${reason} (${file})`);
}
if (added.some((line) => SETTINGS_IN_DIFF.test(line))) reasons.add("adds a line naming a Stripe key, Stripe env var or live mode");

if (reasons.size > 0) {
  console.log(`user merges ${head}:`);
  for (const reason of reasons) console.log(`- ${reason}`);
  process.exit(1);
}
console.log(`${head}: no migration, live-key or payment settings; pstack may merge once review and checks pass`);
