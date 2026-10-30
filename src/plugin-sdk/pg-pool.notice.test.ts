/**
 * Postgres NOTICE handling for plugin pools. postgres.js prints every notice in
 * full by default, so a boot that re-runs CREATE/ADD ... IF NOT EXISTS against
 * existing tables floods the log with routine "already exists, skipping" notices
 * and pushes the boot's own lines out of view. Routine ones are dropped; any other
 * notice becomes one short line.
 */
import { describe, expect, it, vi } from "vitest";
import { createPgNoticeHandler, openPluginPool } from "./pg-pool.js";

const ctx = () => {
  const warn = vi.fn();
  return { ctx: { logger: { warn }, plugin: "test-plugin" }, warn };
};
const notice = (over: Record<string, unknown> = {}) => ({
  severity: "NOTICE",
  code: "42P07",
  message: 'relation "lp_users" already exists, skipping',
  ...over,
});

describe("createPgNoticeHandler", () => {
  for (const [code, message] of [
    ["42P06", 'schema "openclaw" already exists, skipping'],
    ["42P07", 'relation "lp_users" already exists, skipping'],
    ["42701", 'column "vault_secret_name" of relation "syntropy_tokens" already exists, skipping'],
    ["42710", 'extension "pgcrypto" already exists, skipping'],
  ]) {
    it(`drops the routine ${code} "already exists, skipping" notice`, () => {
      const { ctx: c, warn } = ctx();
      createPgNoticeHandler(c)(notice({ code, message }));
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it("any other notice becomes ONE short line with severity, code and the opening plugin", () => {
    const { ctx: c, warn } = ctx();
    createPgNoticeHandler(c)(notice({ code: "01000", message: "something worth knowing" }));
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe(
      "postgres NOTICE 01000 (pool opened by test-plugin): something worth knowing",
    );
  });

  it("a WARNING-severity notice is logged even if its text says 'already exists'", () => {
    const { ctx: c, warn } = ctx();
    // Routine code AND routine text, but WARNING severity: only NOTICEs are dropped.
    createPgNoticeHandler(c)(notice({ severity: "WARNING" }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("postgres WARNING 42P07");
  });

  it("a routine code with a non-routine message is still logged (only the exact pattern is dropped)", () => {
    const { ctx: c, warn } = ctx();
    createPgNoticeHandler(c)(notice({ code: "42P07", message: "something else" }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a non-routine code with routine text is still logged (code AND text must match)", () => {
    const { ctx: c, warn } = ctx();
    createPgNoticeHandler(c)(notice({ code: "01000" }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("routine text must END the message: trailing text is logged", () => {
    const { ctx: c, warn } = ctx();
    createPgNoticeHandler(c)(
      notice({ message: 'relation "t" already exists, skipping; but also something else' }),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("the line is single-line and the message is cut to 200 chars", () => {
    const { ctx: c, warn } = ctx();
    createPgNoticeHandler(c)(notice({ code: "01000", message: `a\nb\r\n${"x".repeat(500)}` }));
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
    const prefix = "postgres NOTICE 01000 (pool opened by test-plugin): ";
    expect(line.startsWith(`${prefix}a b `)).toBe(true);
    expect(line.length - prefix.length).toBe(200);
  });

  it("a non-string code is shown as '?'", () => {
    const { ctx: c, warn } = ctx();
    createPgNoticeHandler(c)(notice({ code: 42, message: "m" }));
    expect(String(warn.mock.calls[0][0])).toBe("postgres NOTICE ? (pool opened by test-plugin): m");
  });

  it("a logger that throws never breaks the caller", () => {
    const warn = vi.fn(() => {
      throw new Error("logger down");
    });
    const h = createPgNoticeHandler({ logger: { warn }, plugin: "p" });
    expect(() => h(notice({ code: "01000" }))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a malformed notice never throws", () => {
    const { ctx: c, warn } = ctx();
    const h = createPgNoticeHandler(c);
    expect(() => h(undefined as never)).not.toThrow();
    expect(() => h({} as never)).not.toThrow();
    expect(() => h("text" as never)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("openPluginPool passes the notice handler to the driver", () => {
  it("the factory receives an onnotice that drops routine notices", () => {
    const { ctx: c, warn } = ctx();
    const factory = vi.fn((_url: string, _opts: Record<string, unknown>) => ({
      end: async () => undefined,
    }));
    const pool = openPluginPool(factory as never, "postgres://notice-test/db", c, {});
    const opts = factory.mock.calls[0][1] as { onnotice?: (n: unknown) => void };
    expect(typeof opts.onnotice).toBe("function");
    opts.onnotice?.(notice());
    expect(warn).not.toHaveBeenCalled();
    void pool.end();
  });
});
