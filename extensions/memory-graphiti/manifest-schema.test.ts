/**
 * The gateway validates every enabled plugin's config against its MANIFEST
 * configSchema (additionalProperties: false) before boot; a failure stops the
 * whole gateway. graphitiConfigSchema.parse is NOT that validator, so this pins
 * the committed openclaw.json entry against the manifest the loader uses.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../src/plugins/schema-validator.js";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
) as { configSchema: Record<string, unknown> };
const appConfig = JSON.parse(
  fs.readFileSync(new URL("../../openclaw.json", import.meta.url), "utf8"),
) as { plugins: { entries: Record<string, { config?: unknown }> } };

const validate = (value: unknown) =>
  validateJsonSchemaValue({ schema: manifest.configSchema, cacheKey: "mg-manifest-test", value });

describe("memory-graphiti manifest configSchema", () => {
  it("accepts the committed openclaw.json memory-graphiti config (else the gateway will not boot)", () => {
    const res = validate(appConfig.plugins.entries["memory-graphiti"]?.config);
    expect(res).toEqual({ ok: true });
  });

  it("the committed config carries no ${...} env reference (a missing var fails the WHOLE config load)", () => {
    expect(JSON.stringify(appConfig.plugins.entries["memory-graphiti"])).not.toMatch(/\$\{/);
  });

  it("control: an unknown key is rejected, so the acceptance above is meaningful", () => {
    expect(validate({ groupIdStrategy: "identity", notAKey: 1 }).ok).toBe(false);
  });

  it("rejects a half-written phiCloudApproval at the schema layer too", () => {
    expect(validate({ phiCloudApproval: { ruling: "x".repeat(25), date: "2026-10-26" } }).ok).toBe(
      false,
    );
  });
});
