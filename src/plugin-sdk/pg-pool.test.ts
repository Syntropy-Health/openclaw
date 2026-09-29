import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PG_POOL_MAX,
  openPluginPool,
  PG_POOL_IDLE_TIMEOUT_S,
  PG_POOL_MAX_ENV,
  resolvePgPoolMax,
} from "./pg-pool.js";

describe("resolvePgPoolMax", () => {
  it("defaults to 1 when unset", () => {
    expect(DEFAULT_PG_POOL_MAX).toBe(1);
    expect(resolvePgPoolMax({})).toEqual({ max: 1 });
  });

  it("honours a valid positive integer", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "4" })).toEqual({ max: 4 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: " 12 " })).toEqual({ max: 12 });
  });

  it("treats empty/whitespace as unset (the normal Fly/Railway 'cleared' state)", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "" })).toEqual({ max: 1 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "   " })).toEqual({ max: 1 });
  });

  it.each(["abc", "0", "-3", "2.5", "1e2", "101", "10abc", "+5", "99999999999999999999"])(
    "rejects %j: falls back to the default AND says so, naming the fallback",
    (raw) => {
      const r = resolvePgPoolMax({ [PG_POOL_MAX_ENV]: raw });
      expect(r.max).toBe(DEFAULT_PG_POOL_MAX);
      expect(r.invalid).toContain(PG_POOL_MAX_ENV);
      expect(r.invalid).toContain(JSON.stringify(raw));
      expect(r.invalid).toContain(`using ${DEFAULT_PG_POOL_MAX}`);
    },
  );

  it("accepts the bounds 1 and 100", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "1" })).toEqual({ max: 1 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "100" })).toEqual({ max: 100 });
  });
});

describe("openPluginPool — the resolved size actually reaches the driver", () => {
  const logger = () => ({ warn: vi.fn() });

  it("passes max (default) and idle_timeout to the factory, and returns its pool", () => {
    const pool = { tag: "pool" };
    const factory = vi.fn(() => pool);
    const log = logger();
    expect(openPluginPool(factory, "postgres://x", { logger: log, plugin: "p" }, {})).toBe(pool);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("postgres://x", {
      max: 1,
      idle_timeout: PG_POOL_IDLE_TIMEOUT_S,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("an env override reaches the driver", () => {
    const factory = vi.fn(() => ({}));
    openPluginPool(factory, "u", { logger: logger(), plugin: "p" }, { [PG_POOL_MAX_ENV]: "4" });
    expect(factory.mock.calls[0][1]).toEqual({ max: 4, idle_timeout: PG_POOL_IDLE_TIMEOUT_S });
  });

  it("an invalid override warns ONCE with the plugin name and the raw value, and uses the default", () => {
    const factory = vi.fn(() => ({}));
    const log = logger();
    openPluginPool(
      factory,
      "u",
      { logger: log, plugin: "memory-graphiti" },
      {
        [PG_POOL_MAX_ENV]: "abc",
      },
    );
    expect(factory.mock.calls[0][1].max).toBe(DEFAULT_PG_POOL_MAX);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/^memory-graphiti: OPENCLAW_PG_POOL_MAX="abc"/);
  });

  it("never passes the connection URL into the warning", () => {
    const log = logger();
    openPluginPool(
      () => ({}),
      "postgres://user:SECRET@host/db",
      { logger: log, plugin: "p" },
      {
        [PG_POOL_MAX_ENV]: "x",
      },
    );
    expect(log.warn.mock.calls[0][0]).not.toContain("SECRET");
  });
});
