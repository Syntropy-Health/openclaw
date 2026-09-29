import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PG_POOL_MAX,
  openPluginPool,
  PG_POOL_CONNECT_TIMEOUT_S,
  PG_POOL_IDLE_TIMEOUT_S,
  PG_POOL_MAX_CEILING,
  PG_POOL_MAX_ENV,
  resolvePgPoolMax,
  sharedPgPoolHolders,
} from "./pg-pool.js";

describe("resolvePgPoolMax", () => {
  it("defaults to 5 when unset", () => {
    expect(DEFAULT_PG_POOL_MAX).toBe(5);
    expect(resolvePgPoolMax({})).toEqual({ max: 5 });
  });

  it("honours a valid integer up to the ceiling", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "3" })).toEqual({ max: 3 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: " 9 " })).toEqual({ max: 9 });
  });

  it("treats empty/whitespace as unset (the normal Fly/Railway 'cleared' state)", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "" })).toEqual({ max: 5 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "   " })).toEqual({ max: 5 });
  });

  it.each(["abc", "0", "-3", "2.5", "1e2", "10", "100", "10abc", "+5", "99999999999999999999"])(
    "rejects %j (incl. anything over the ceiling): default AND a message naming the fallback",
    (raw) => {
      const r = resolvePgPoolMax({ [PG_POOL_MAX_ENV]: raw });
      expect(r.max).toBe(DEFAULT_PG_POOL_MAX);
      expect(r.invalid).toContain(PG_POOL_MAX_ENV);
      expect(r.invalid).toContain(JSON.stringify(raw));
      expect(r.invalid).toContain(`[1, ${PG_POOL_MAX_CEILING}]`);
      expect(r.invalid).toContain(`using ${DEFAULT_PG_POOL_MAX}`);
    },
  );

  it("the default never exceeds the ceiling", () => {
    expect(DEFAULT_PG_POOL_MAX).toBeLessThanOrEqual(PG_POOL_MAX_CEILING);
  });
});

/** A fake pool: callable (tagged template) with an end() that records calls. */
function fakePool() {
  const calls: unknown[][] = [];
  const pool = Object.assign(
    (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(["row"]);
    },
    { end: vi.fn(() => Promise.resolve()), marker: "pool" },
  );
  return { pool, calls };
}

let urlSeq = 0;
const freshUrl = () => `postgres://host/db-${(urlSeq += 1)}`;
const log = () => ({ warn: vi.fn() });

describe("openPluginPool — options reach the driver", () => {
  it("passes max (default), idle_timeout and connect_timeout", () => {
    const { pool } = fakePool();
    const factory = vi.fn(() => pool);
    const url = freshUrl();
    openPluginPool(factory, url, { logger: log(), plugin: "p" }, {});
    expect(factory).toHaveBeenCalledWith(url, {
      max: 5,
      idle_timeout: PG_POOL_IDLE_TIMEOUT_S,
      connect_timeout: PG_POOL_CONNECT_TIMEOUT_S,
    });
  });

  it("an env override reaches the driver", () => {
    const factory = vi.fn(() => fakePool().pool);
    openPluginPool(factory, freshUrl(), { logger: log(), plugin: "p" }, { [PG_POOL_MAX_ENV]: "3" });
    expect(factory.mock.calls[0][1].max).toBe(3);
  });

  it("an invalid override warns ONCE with the plugin name and never the URL", () => {
    const factory = vi.fn(() => fakePool().pool);
    const l = log();
    openPluginPool(
      factory,
      "postgres://user:SECRET@host/db-warn",
      { logger: l, plugin: "memory-graphiti" },
      {
        [PG_POOL_MAX_ENV]: "abc",
      },
    );
    expect(factory.mock.calls[0][1].max).toBe(DEFAULT_PG_POOL_MAX);
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.warn.mock.calls[0][0]).toMatch(/^memory-graphiti: OPENCLAW_PG_POOL_MAX="abc"/);
    expect(l.warn.mock.calls[0][0]).not.toContain("SECRET");
  });
});

describe("openPluginPool — one shared pool per URL, reference-counted", () => {
  it("two plugins on the same URL share ONE driver pool; calls pass through", async () => {
    const { pool, calls } = fakePool();
    const factory = vi.fn(() => pool);
    const url = freshUrl();
    const a = openPluginPool(factory, url, { logger: log(), plugin: "a" }, {});
    const b = openPluginPool(factory, url, { logger: log(), plugin: "b" }, {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(await (a as unknown as (...x: unknown[]) => Promise<unknown>)("q1")).toEqual(["row"]);
    expect(await (b as unknown as (...x: unknown[]) => Promise<unknown>)("q2")).toEqual(["row"]);
    expect(calls).toEqual([["q1"], ["q2"]]);
    expect((a as unknown as { marker: string }).marker).toBe("pool");
  });

  it("different URLs get different pools", () => {
    const factory = vi.fn(() => fakePool().pool);
    openPluginPool(factory, freshUrl(), { logger: log(), plugin: "a" }, {});
    openPluginPool(factory, freshUrl(), { logger: log(), plugin: "b" }, {});
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("the pool closes only when the LAST holder ends; a double end releases once", async () => {
    const { pool } = fakePool();
    const factory = vi.fn(() => pool);
    const url = freshUrl();
    const a = openPluginPool(factory, url, { logger: log(), plugin: "a" }, {});
    const b = openPluginPool(factory, url, { logger: log(), plugin: "b" }, {});
    await a.end();
    await a.end(); // must not release b's reference
    expect(pool.end).not.toHaveBeenCalled();
    await b.end({ timeout: 5 } as never);
    expect(pool.end).toHaveBeenCalledTimes(1);
    expect(pool.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("after the last holder ends, the next open creates a fresh pool", async () => {
    const factory = vi.fn(() => fakePool().pool);
    const url = freshUrl();
    const a = openPluginPool(factory, url, { logger: log(), plugin: "a" }, {});
    await a.end();
    openPluginPool(factory, url, { logger: log(), plugin: "a" }, {});
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("diagnostics expose holder counts only — never a URL", () => {
    const url = "postgres://u:SECRET2@h/diag";
    openPluginPool(() => fakePool().pool, url, { logger: log(), plugin: "a" }, {});
    const view = sharedPgPoolHolders();
    expect(view.every((n) => typeof n === "number")).toBe(true);
    expect(JSON.stringify(view)).not.toContain("SECRET2");
  });
});
