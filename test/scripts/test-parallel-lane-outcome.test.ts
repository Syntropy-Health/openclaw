import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Runs the real scripts/test-parallel.mjs with a stub `pnpm` first on PATH, so
// each lane's vitest is replaced by a script whose behaviour the test controls.
const SCRIPT = path.resolve(__dirname, "../../scripts/test-parallel.mjs");
const dirs: string[] = [];

function runWithStubPnpm(stubBody: string, env: Record<string, string> = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "tp-stub-"));
  dirs.push(bin);
  const stub = path.join(bin, "pnpm");
  fs.writeFileSync(stub, `#!/bin/sh\n${stubBody}\n`, { mode: 0o755 });
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      OPENCLAW_VITEST_REPORT_DIR: "",
      OPENCLAW_TEST_WATCHDOG_MS: "",
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return res.status;
}

// Writes a vitest-style JSON report to the path after --outputFile (if any).
const writeReport = (success: boolean) => `
out=""; prev=""
for a in "$@"; do [ "$prev" = "--outputFile" ] && out="$a"; prev="$a"; done
[ -n "$out" ] && printf '{"success":${success},"numFailedTestSuites":${success ? 0 : 1},"testResults":[]}' > "$out"
exit 0`;

afterEach(() => {
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("test-parallel lane outcome", () => {
  it("fails the run when a lane exits 0 without producing its report", () => {
    expect(runWithStubPnpm("exit 0")).not.toBe(0);
  });

  it("fails the run when a lane is killed by a signal", () => {
    expect(runWithStubPnpm("kill -9 $$")).not.toBe(0);
  });

  it("fails the run when a lane's report says it failed", () => {
    expect(runWithStubPnpm(writeReport(false))).not.toBe(0);
  });

  it("does not let a stale report from an earlier run pass a lane", () => {
    const reports = fs.mkdtempSync(path.join(os.tmpdir(), "tp-reports-"));
    dirs.push(reports);
    for (const name of ["unit", "unit-fast", "unit-isolated", "extensions", "gateway"]) {
      fs.writeFileSync(
        path.join(reports, `vitest-${name}.json`),
        '{"success":true,"numFailedTestSuites":0,"testResults":[]}',
      );
    }
    expect(runWithStubPnpm("exit 0", { OPENCLAW_VITEST_REPORT_DIR: reports })).not.toBe(0);
  });

  it("passes when every lane exits 0 with a successful report", () => {
    expect(runWithStubPnpm(writeReport(true))).toBe(0);
  });
});
