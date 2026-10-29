/**
 * `highlights.rank` (A&D §4.3): the ranking constants come from plugin config.
 * The parser and the manifest schema (the loader's own validator) must agree.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";
import { graphitiConfigSchema } from "./config.js";
import { DEFAULT_RANK_CONFIG } from "./highlights/rank.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };

const validate = (value: unknown) =>
  validateJsonSchemaValue({ schema: manifest.configSchema, cacheKey: "mg-hl-cfg", value });

const parse = (highlights: unknown) =>
  graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000", highlights });

describe("highlights.rank config", () => {
  it("absent: the parsed config resolves to the PVR R3 defaults", () => {
    const cfg = graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000" });
    expect(cfg.highlights?.rank).toEqual(DEFAULT_RANK_CONFIG);
    expect(parse({}).highlights?.rank).toEqual(DEFAULT_RANK_CONFIG);
  });

  it("a partial block overrides only the keys it sets", () => {
    expect(parse({ rank: { halfLifeDays: 30, wSal: 0 } }).highlights?.rank).toEqual({
      ...DEFAULT_RANK_CONFIG,
      halfLifeDays: 30,
      wSal: 0,
    });
    expect(validate({ highlights: { rank: { halfLifeDays: 30, wSal: 0 } } })).toEqual({ ok: true });
  });

  const bad: Array<[string, unknown]> = [
    ["unknown highlights key", { extra: 1 }],
    ["unknown rank key", { rank: { wFoo: 1 } }],
    ["zero half-life", { rank: { halfLifeDays: 0 } }],
    ["negative weight", { rank: { wOcc: -0.1 } }],
    ["string weight", { rank: { wLink: "0.5" } }],
    ["huge half-life", { rank: { halfLifeDays: 100_000 } }],
    ["weight too large", { rank: { wSal: 11 } }],
    ["rank not an object", { rank: [] }],
  ];
  for (const [label, value] of bad) {
    it(`rejects ${label} in both the parser and the manifest`, () => {
      expect(() => parse(value)).toThrow(/highlights/);
      expect(validate({ highlights: value }).ok).toBe(false);
    });
  }

  it("rejects a non-finite half-life in the parser (JSON cannot carry one)", () => {
    expect(() => parse({ rank: { halfLifeDays: Number.POSITIVE_INFINITY } })).toThrow(/highlights/);
    expect(() => parse({ rank: { wOcc: Number.NaN } })).toThrow(/highlights/);
  });
});
