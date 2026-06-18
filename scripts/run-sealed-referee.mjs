#!/usr/bin/env node
// run-sealed-referee.mjs — AIADLC sealed-suite runner for `tools/referee`.
//
// Runs ONLY the sealed vitest project (vitest.sealed.config.ts) and prints one
// coarse verdict line per test in the referee's accepted form:
//
//     RESULT pass <category>
//     RESULT fail <category>
//
// `<category>` is slash-namespaced: it is the test's top-level describe() name
// (e.g. `functional/formatter`, `integration/hook`). The referee aggregates
// passed/total per category and NEVER surfaces assertion text, so the
// implementer debugs by *behavior category*, not by assertion.
//
// Robust across vitest reporter-API churn: we drive vitest's stable JSON
// reporter and translate its output, rather than implementing a custom
// in-process Reporter class.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestBin = path.join(repoRoot, "node_modules", ".bin", "vitest");
const outDir = mkdtempSync(path.join(tmpdir(), "sealed-referee-"));
const outFile = path.join(outDir, "results.json");

try {
  spawnSync(
    vitestBin,
    ["run", "--config", "vitest.sealed.config.ts", "--reporter=json", `--outputFile=${outFile}`],
    // stderr is NOT inherited and NOT captured: vitest diagnostics (assertion
    // diffs, file:line, stack traces) must never bridge to the implementer, who
    // runs `referee run`. Only the coarse RESULT lines below reach stdout. The
    // machine-readable verdicts go to the JSON outputFile, which we parse.
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    // No output file → suite failed to run at all (e.g. the whole project
    // failed to compile, or there are genuinely no sealed tests). Emit nothing;
    // the referee reports total=0, which is itself a red flag that the runner
    // could not produce verdicts.
    process.exit(0);
  }

  const slug = (s) =>
    String(s || "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9/_-]/g, "")
      .toLowerCase();

  for (const file of report.testResults ?? []) {
    const base = path.basename(file.name || "suite").replace(/\.sealed\.test\.ts$/, "");
    const assertions = file.assertionResults ?? [];
    // A file that failed to COLLECT (compile error, missing import, throw at
    // module load) has status "failed" but zero assertions. Surface that as a
    // distinct coarse category so the implementer sees a real failure signal
    // instead of a misleading total=0. No assertion text leaks — just a label.
    if (assertions.length === 0 && file.status === "failed") {
      console.log("RESULT fail build/load");
      continue;
    }
    for (const a of assertions) {
      // Category = top-level describe, else file basename. Slash-namespaced.
      const category = slug((a.ancestorTitles && a.ancestorTitles[0]) || base);
      if (a.status === "passed") console.log(`RESULT pass ${category}`);
      else if (a.status === "failed") console.log(`RESULT fail ${category}`);
      // pending/skipped/todo: not a verdict — omit.
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
