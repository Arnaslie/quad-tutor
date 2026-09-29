import { execFileSync } from "node:child_process";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function refuse(reason) {
  console.error(`\nRefusing to migrate a remote database: ${reason}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) refuse("DATABASE_URL is not set.");

let host;
try {
  host = new URL(url).hostname;
} catch {
  refuse("DATABASE_URL is not a parseable URL.");
}
if (LOCAL_HOSTS.has(host)) process.exit(0);

console.log(`Migrating ${host} — checking this checkout matches origin/main…`);

try {
  git("fetch", "--quiet", "origin", "main");
} catch {
  refuse("could not fetch origin/main to compare against.");
}

const head = git("rev-parse", "HEAD");
const remote = git("rev-parse", "origin/main");
if (head !== remote) {
  refuse(
    `this checkout is at ${head.slice(0, 7)}, origin/main is at ${remote.slice(0, 7)}. ` +
      "Run `git checkout main && git pull` first, so every merged migration is on disk.",
  );
}

if (git("status", "--porcelain", "--", "drizzle")) {
  refuse("drizzle/ has uncommitted changes. Only migrations merged to main go to a remote database.");
}
