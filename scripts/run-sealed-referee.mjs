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
    [
      "run",
      "--config",
      "vitest.sealed.config.ts",
      "--reporter=json",
      `--outputFile=${outFile}`,
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"] },
  );

  let report;
  try {
    report = JSON.parse(readFileSync(outFile, "utf8"));
  } catch {
    // No output file → suite failed to run at all (compile error, no tests).
    // Emit nothing; referee will report total=0 (a red flag the runner failed),
    // and stderr (inherited above) carries the diagnostic for a human.
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
    for (const a of file.assertionResults ?? []) {
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
