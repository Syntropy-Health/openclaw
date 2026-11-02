import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { runCommandWithTimeout, shouldSpawnWithShell } from "./exec.js";

describe("runCommandWithTimeout", () => {
  it("never enables shell execution (Windows cmd.exe injection hardening)", () => {
    expect(
      shouldSpawnWithShell({
        resolvedCommand: "npm.cmd",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("merges custom env with process.env", async () => {
    const envSnapshot = captureEnv(["OPENCLAW_BASE_ENV"]);
    process.env.OPENCLAW_BASE_ENV = "base";
    try {
      const result = await runCommandWithTimeout(
        [
          process.execPath,
          "-e",
          'process.stdout.write((process.env.OPENCLAW_BASE_ENV ?? "") + "|" + (process.env.OPENCLAW_TEST_ENV ?? ""))',
        ],
        {
          timeoutMs: 5_000,
          env: { OPENCLAW_TEST_ENV: "ok" },
        },
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("base|ok");
      expect(result.termination).toBe("exit");
    } finally {
      envSnapshot.restore();
    }
  });

  it("kills command when no output timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      {
        timeoutMs: 5_000,
        noOutputTimeoutMs: 50,
      },
    );

    expect(result.termination).toBe("no-output-timeout");
    expect(result.noOutputTimedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  // The no-output timer's reset logic is tested on a fake clock in
  // exec.no-output-timer.test.ts. A real child cannot test it reliably: the timer arms
  // at spawn, so a slow cold start fails it on busy runners (Windows CI).

  it("reports global timeout termination when overall timeout elapses", async () => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
      {
        timeoutMs: 15,
      },
    );

    expect(result.termination).toBe("timeout");
    expect(result.noOutputTimedOut).toBe(false);
    expect(result.code).not.toBe(0);
  });
});
