#!/usr/bin/env node
// Fail unless every Postgres-backed test suite actually RAN (not skipped) in this CI job.
//
// Those suites skip themselves when DATABASE_URL is unset, so a broken database step would leave CI green with
// the suites silently skipped. Suites are DISCOVERED: any extensions/** integration test (`*.integration.test.ts`
// or `integration.test.ts`) that reads process.env.DATABASE_URL, so a new one is covered without editing this
// file. Plain unit tests that merely mention the variable are not Postgres suites and are not required here.
//
// Usage: node scripts/ci/assert-pg-integration-ran.mjs <vitest-json-report-dir>
import fs from "node:fs";
import path from "node:path";

const reportDir = process.argv[2];
if (!reportDir || !fs.existsSync(reportDir)) {
  console.error(`assert-pg-integration-ran: report dir missing: ${reportDir ?? "(none)"}`);
  process.exit(2);
}

const root = process.cwd();
const toPosix = (p) => p.split(path.sep).join("/");
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) {
      continue; // never descend into deps
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}
const suites = walk(path.join(root, "extensions"), [])
  .map((full) => toPosix(path.relative(root, full)))
  .filter((rel) => rel.endsWith(".integration.test.ts") || rel.endsWith("/integration.test.ts"))
  .filter((rel) =>
    fs.readFileSync(path.join(root, rel), "utf8").includes("process.env.DATABASE_URL"),
  )
  .toSorted();

if (suites.length === 0) {
  console.error(
    "assert-pg-integration-ran: found no suite reading process.env.DATABASE_URL (discovery broken?)",
  );
  process.exit(1);
}

const results = new Map(); // suite rel path -> { passed, failed, skipped }
for (const name of fs.readdirSync(reportDir).filter((n) => n.endsWith(".json"))) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(reportDir, name), "utf8"));
  } catch {
    continue;
  }
  for (const suite of Array.isArray(payload?.testResults) ? payload.testResults : []) {
    const rel = toPosix(path.relative(root, String(suite?.name ?? "")));
    const tally = results.get(rel) ?? { passed: 0, failed: 0, skipped: 0 };
    for (const a of Array.isArray(suite?.assertionResults) ? suite.assertionResults : []) {
      if (a?.status === "passed") {
        tally.passed += 1;
      } else if (a?.status === "failed") {
        tally.failed += 1;
      } else {
        tally.skipped += 1; // skipped / pending / todo / disabled
      }
    }
    results.set(rel, tally);
  }
}

const bad = [];
for (const rel of suites) {
  const t = results.get(rel);
  if (!t) {
    bad.push(`${rel}: not in any report (did not run)`);
  } else if (t.passed === 0 || t.skipped > 0) {
    bad.push(`${rel}: passed=${t.passed} skipped=${t.skipped}`);
  }
}
for (const rel of suites) {
  const t = results.get(rel);
  console.log(
    `${bad.some((b) => b.startsWith(rel)) ? "FAIL" : "ok  "} ${rel} ${t ? `passed=${t.passed} skipped=${t.skipped} failed=${t.failed}` : ""}`,
  );
}
if (bad.length) {
  console.error(
    `assert-pg-integration-ran: ${bad.length} Postgres-backed suite(s) did not fully run:\n  ${bad.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`assert-pg-integration-ran: all ${suites.length} Postgres-backed suites ran.`);
