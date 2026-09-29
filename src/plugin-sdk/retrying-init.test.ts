import { describe, expect, it, vi } from "vitest";
import { createRetryingInit } from "./retrying-init.js";

function setup(failures: number) {
  let t = 1_000_000;
  let attempts = 0;
  let remaining = failures;
  const logger = { info: vi.fn(), error: vi.fn() };
  const ensure = createRetryingInit(
    async () => {
      attempts += 1;
      if (remaining > 0) {
        remaining -= 1;
        throw new Error("too many connections for role");
      }
    },
    { logger, plugin: "persist-postgres", now: () => t },
  );
  return {
    ensure,
    logger,
    attempts: () => attempts,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createRetryingInit", () => {
  it("runs init once on success and never again", async () => {
    const s = setup(0);
    await s.ensure();
    await s.ensure();
    expect(s.attempts()).toBe(1);
  });

  it("a failed init is NOT cached forever: it retries after the backoff window", async () => {
    const s = setup(1);
    await expect(s.ensure()).rejects.toThrow("too many connections");
    s.advance(1_000);
    await expect(s.ensure()).resolves.toBeUndefined();
    expect(s.attempts()).toBe(2);
  });

  it("inside the window it rethrows the last error without a new attempt", async () => {
    const s = setup(5);
    await expect(s.ensure()).rejects.toThrow();
    await expect(s.ensure()).rejects.toThrow();
    s.advance(999);
    await expect(s.ensure()).rejects.toThrow();
    expect(s.attempts()).toBe(1);
  });

  it("backoff doubles and caps at 60s", async () => {
    const s = setup(100);
    await expect(s.ensure()).rejects.toThrow(); // attempt 1 -> wait 1s
    const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [i, w] of waits.entries()) {
      s.advance(w - 1);
      await expect(s.ensure()).rejects.toThrow();
      expect(s.attempts(), `no attempt before ${w}ms (step ${i})`).toBe(i + 1);
      s.advance(1);
      await expect(s.ensure()).rejects.toThrow();
      expect(s.attempts(), `attempt at ${w}ms (step ${i})`).toBe(i + 2);
    }
  });

  it("concurrent callers share one in-flight attempt", async () => {
    const s = setup(0);
    await Promise.all([s.ensure(), s.ensure(), s.ensure()]);
    expect(s.attempts()).toBe(1);
  });

  it("logs each failure with its retry delay, never 'will not retry'", async () => {
    const s = setup(1);
    await expect(s.ensure()).rejects.toThrow();
    const errors = s.logger.error.mock.calls.flat().join("\n");
    expect(errors).toMatch(/^persist-postgres: init failed \(attempt 1, retry in 1s\): /);
    expect(errors).not.toContain("will not retry");
  });

  it("a falsy thrown value still opens a window (no silent re-probe on every call)", async () => {
    let attempts = 0;
    const ensure = createRetryingInit(
      async () => {
        attempts += 1;
        throw undefined;
      },
      { logger: { info: vi.fn(), error: vi.fn() }, plugin: "p", now: () => 5 },
    );
    await expect(ensure()).rejects.toBeDefined();
    await expect(ensure()).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });
});
