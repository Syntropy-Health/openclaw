import { describe, expect, it } from "vitest";
import { DEFAULT_PG_POOL_MAX, PG_POOL_MAX_ENV, resolvePgPoolMax } from "./pg-pool.js";

describe("resolvePgPoolMax", () => {
  it("defaults to 2 when unset (budget arithmetic lives in pg-pool.enumeration.test.ts)", () => {
    expect(DEFAULT_PG_POOL_MAX).toBe(2);
    expect(resolvePgPoolMax({})).toEqual({ max: 2 });
  });

  it("honours a valid positive integer", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "4" })).toEqual({ max: 4 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: " 12 " })).toEqual({ max: 12 });
  });

  it("treats empty/whitespace as unset (the normal Fly/Railway 'cleared' state)", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "" })).toEqual({ max: 2 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "   " })).toEqual({ max: 2 });
  });

  it.each(["abc", "0", "-3", "2.5", "1e2", "101", "10abc"])(
    "rejects %j: falls back to the default AND reports why (never silently)",
    (raw) => {
      const r = resolvePgPoolMax({ [PG_POOL_MAX_ENV]: raw });
      expect(r.max).toBe(DEFAULT_PG_POOL_MAX);
      expect(r.invalid).toContain(PG_POOL_MAX_ENV);
      expect(r.invalid).toContain(JSON.stringify(raw));
    },
  );

  it("accepts the bounds 1 and 100", () => {
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "1" })).toEqual({ max: 1 });
    expect(resolvePgPoolMax({ [PG_POOL_MAX_ENV]: "100" })).toEqual({ max: 100 });
  });
});
