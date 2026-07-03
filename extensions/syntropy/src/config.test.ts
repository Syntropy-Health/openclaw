/**
 * Unit tests for syntropy plugin config validation + DI.
 *
 * Requirements (from PR #9 review follow-up, Item 3):
 * - Parse + validate plugin config at register() time
 * - Fail-fast on missing `syntropyBaseUrl` in production (NODE_ENV=production)
 * - Allow localhost fallback in non-production for local dev
 * - Pull databaseUrl from pluginConfig OR env.DATABASE_URL (in that order)
 * - Throw structured error with field names — not silent localhost routing
 */

import { describe, test, expect } from "vitest";
import { parseSyntropyConfig } from "./config.js";

describe("parseSyntropyConfig", () => {
  test("returns a Config object with valid inputs", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
      },
      { NODE_ENV: "production" },
    );
    expect(cfg.syntropyBaseUrl).toBe("https://api.syntropy.example");
    expect(cfg.databaseUrl).toBe("postgres://localhost/db");
  });

  test("falls back to env.DATABASE_URL when pluginConfig.databaseUrl missing", () => {
    const cfg = parseSyntropyConfig(
      { syntropyBaseUrl: "https://api.syntropy.example" },
      { NODE_ENV: "production", DATABASE_URL: "postgres://env/db" },
    );
    expect(cfg.databaseUrl).toBe("postgres://env/db");
  });

  test("pluginConfig.databaseUrl wins over env.DATABASE_URL", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://explicit/db",
      },
      { NODE_ENV: "production", DATABASE_URL: "postgres://env/db" },
    );
    expect(cfg.databaseUrl).toBe("postgres://explicit/db");
  });

  test("throws on missing syntropyBaseUrl in production", () => {
    expect(() =>
      parseSyntropyConfig({ databaseUrl: "postgres://localhost/db" }, { NODE_ENV: "production" }),
    ).toThrow(/syntropyBaseUrl/);
  });

  test("falls back to localhost in non-production when syntropyBaseUrl missing", () => {
    const cfg = parseSyntropyConfig(
      { databaseUrl: "postgres://localhost/db" },
      { NODE_ENV: "development" },
    );
    expect(cfg.syntropyBaseUrl).toBe("http://localhost:3000");
  });

  test("falls back to localhost when NODE_ENV is unset (treated as non-production)", () => {
    const cfg = parseSyntropyConfig({ databaseUrl: "postgres://localhost/db" }, {});
    expect(cfg.syntropyBaseUrl).toBe("http://localhost:3000");
  });

  test("throws on missing databaseUrl in production with no env fallback", () => {
    expect(() =>
      parseSyntropyConfig(
        { syntropyBaseUrl: "https://api.syntropy.example" },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/databaseUrl/);
  });

  test("throws on non-URL syntropyBaseUrl", () => {
    expect(() =>
      parseSyntropyConfig(
        { syntropyBaseUrl: "not-a-url", databaseUrl: "postgres://localhost/db" },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/syntropyBaseUrl/);
  });

  test("rejects non-string syntropyBaseUrl with type-narrowed error", () => {
    expect(() =>
      parseSyntropyConfig(
        { syntropyBaseUrl: 42, databaseUrl: "postgres://localhost/db" },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/syntropyBaseUrl/);
  });

  test("strips unknown fields without error", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
        extraField: "ignored",
      },
      { NODE_ENV: "production" },
    );
    expect(cfg).toEqual({
      syntropyBaseUrl: "https://api.syntropy.example",
      databaseUrl: "postgres://localhost/db",
      // braintrust is always present (defaults applied) — see dedicated suite.
      braintrust: { enabled: false, projectName: "claw", logContent: false },
    });
  });

  test("error message includes NODE_ENV context for ops-debuggability", () => {
    try {
      parseSyntropyConfig({}, { NODE_ENV: "production" });
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toMatch(/production/);
    }
  });

  // -------------------------------------------------------------------------
  // SYN-33 — KG-direct fields (Phase C). Optional; absent values stay
  // absent so downstream feature-flag logic can detect "not configured"
  // vs "explicitly disabled" via undefined.
  // -------------------------------------------------------------------------

  test("kgBaseUrl + enableKgDirect are optional — absent stays absent", () => {
    const cfg = parseSyntropyConfig(
      { syntropyBaseUrl: "https://api.syntropy.example", databaseUrl: "postgres://localhost/db" },
      { NODE_ENV: "production" },
    );
    expect(cfg.kgBaseUrl).toBeUndefined();
    expect(cfg.enableKgDirect).toBeUndefined();
  });

  test("kgBaseUrl is wired through when provided", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
        kgBaseUrl: "https://kg-mcp-test.up.railway.app",
        enableKgDirect: true,
      },
      { NODE_ENV: "production" },
    );
    expect(cfg.kgBaseUrl).toBe("https://kg-mcp-test.up.railway.app");
    expect(cfg.enableKgDirect).toBe(true);
  });

  test("kgBaseUrl rejects unparseable URL with field-tagged error", () => {
    expect(() =>
      parseSyntropyConfig(
        {
          syntropyBaseUrl: "https://api.syntropy.example",
          databaseUrl: "postgres://localhost/db",
          kgBaseUrl: "not-a-url",
        },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/kgBaseUrl/);
  });

  test("enableKgDirect=false is preserved as explicit opt-out", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
        kgBaseUrl: "https://kg-mcp-test.up.railway.app",
        enableKgDirect: false,
      },
      { NODE_ENV: "production" },
    );
    // false !== undefined — index.ts uses this to distinguish "user
    // explicitly disabled" from "not configured at all".
    expect(cfg.enableKgDirect).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Braintrust observability — default OFF; PHI-safe defaults.
  // -------------------------------------------------------------------------

  const base = {
    syntropyBaseUrl: "https://api.syntropy.example",
    databaseUrl: "postgres://localhost/db",
  };

  test("braintrust defaults: disabled, project=claw, logContent=false, no apiKey", () => {
    const cfg = parseSyntropyConfig(base, { NODE_ENV: "production" });
    expect(cfg.braintrust).toEqual({
      enabled: false,
      projectName: "claw",
      logContent: false,
    });
    expect(cfg.braintrust.apiKey).toBeUndefined();
  });

  test("braintrust apiKey layers from env.BRAINTRUST_API_KEY", () => {
    const cfg = parseSyntropyConfig(
      { ...base, braintrust: { enabled: true } },
      { NODE_ENV: "production", BRAINTRUST_API_KEY: "bt_env_key" },
    );
    expect(cfg.braintrust.enabled).toBe(true);
    expect(cfg.braintrust.apiKey).toBe("bt_env_key");
  });

  test("explicit braintrust.apiKey wins over env.BRAINTRUST_API_KEY", () => {
    const cfg = parseSyntropyConfig(
      { ...base, braintrust: { enabled: true, apiKey: "bt_explicit" } },
      { NODE_ENV: "production", BRAINTRUST_API_KEY: "bt_env_key" },
    );
    expect(cfg.braintrust.apiKey).toBe("bt_explicit");
  });

  test("braintrust.projectName override is honored", () => {
    const cfg = parseSyntropyConfig(
      { ...base, braintrust: { enabled: true, projectName: "claw-staging" } },
      { NODE_ENV: "production" },
    );
    expect(cfg.braintrust.projectName).toBe("claw-staging");
  });

  test("braintrust.logContent opt-in is preserved", () => {
    const cfg = parseSyntropyConfig(
      { ...base, braintrust: { enabled: true, logContent: true } },
      { NODE_ENV: "production" },
    );
    expect(cfg.braintrust.logContent).toBe(true);
  });

  test("env.BRAINTRUST_API_KEY present but braintrust disabled → still off, key still resolved", () => {
    // Disabled is the gate; index.ts only inits when enabled. The key may still
    // be carried (harmless) since enabled=false short-circuits init.
    const cfg = parseSyntropyConfig(base, {
      NODE_ENV: "production",
      BRAINTRUST_API_KEY: "bt_env_key",
    });
    expect(cfg.braintrust.enabled).toBe(false);
  });

  test("braintrust strips unknown nested fields", () => {
    const cfg = parseSyntropyConfig(
      {
        ...base,
        braintrust: { enabled: true, apiKey: "k", bogus: "x", projectName: "claw" },
      },
      { NODE_ENV: "production" },
    );
    expect(cfg.braintrust).toEqual({
      enabled: true,
      apiKey: "k",
      projectName: "claw",
      logContent: false,
    });
  });
});
