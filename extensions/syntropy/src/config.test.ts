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
  // Production-mode tests include the Supabase fields needed by token-storage
  // hardening (PR #12 follow-up). Use a small helper for readability.
  const PROD_SUPABASE = {
    supabaseUrl: "https://x.supabase.co",
    supabaseServiceRoleKey: "sb_service_role_xxx",
  };

  test("returns a Config object with valid inputs", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
        ...PROD_SUPABASE,
      },
      { NODE_ENV: "production" },
    );
    expect(cfg.syntropyBaseUrl).toBe("https://api.syntropy.example");
    expect(cfg.databaseUrl).toBe("postgres://localhost/db");
  });

  test("falls back to env.DATABASE_URL when pluginConfig.databaseUrl missing", () => {
    const cfg = parseSyntropyConfig(
      { syntropyBaseUrl: "https://api.syntropy.example", ...PROD_SUPABASE },
      { NODE_ENV: "production", DATABASE_URL: "postgres://env/db" },
    );
    expect(cfg.databaseUrl).toBe("postgres://env/db");
  });

  test("pluginConfig.databaseUrl wins over env.DATABASE_URL", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://explicit/db",
        ...PROD_SUPABASE,
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
        ...PROD_SUPABASE,
        extraField: "ignored",
      },
      { NODE_ENV: "production" },
    );
    expect(cfg).toEqual({
      syntropyBaseUrl: "https://api.syntropy.example",
      databaseUrl: "postgres://localhost/db",
      ...PROD_SUPABASE,
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

  // ---------------------------------------------------------------------
  // Supabase Vault credentials (PR #12 follow-up — token storage hardening)
  // ---------------------------------------------------------------------

  test("accepts supabaseUrl + supabaseServiceRoleKey from pluginConfig", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
        supabaseUrl: "https://x.supabase.co",
        supabaseServiceRoleKey: "sb_service_role_xxx",
      },
      { NODE_ENV: "production" },
    );
    expect(cfg.supabaseUrl).toBe("https://x.supabase.co");
    expect(cfg.supabaseServiceRoleKey).toBe("sb_service_role_xxx");
  });

  test("falls back to env.SUPABASE_URL and env.SUPABASE_SERVICE_ROLE_KEY", () => {
    const cfg = parseSyntropyConfig(
      {
        syntropyBaseUrl: "https://api.syntropy.example",
        databaseUrl: "postgres://localhost/db",
      },
      {
        NODE_ENV: "production",
        SUPABASE_URL: "https://envurl.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "sb_service_role_env",
      },
    );
    expect(cfg.supabaseUrl).toBe("https://envurl.supabase.co");
    expect(cfg.supabaseServiceRoleKey).toBe("sb_service_role_env");
  });

  test("Supabase credentials are undefined when missing in non-production", () => {
    const cfg = parseSyntropyConfig(
      { syntropyBaseUrl: "https://api.syntropy.example", databaseUrl: "postgres://localhost/db" },
      { NODE_ENV: "development" },
    );
    expect(cfg.supabaseUrl).toBeUndefined();
    expect(cfg.supabaseServiceRoleKey).toBeUndefined();
  });

  test("throws on missing supabaseUrl in production", () => {
    expect(() =>
      parseSyntropyConfig(
        {
          syntropyBaseUrl: "https://api.syntropy.example",
          databaseUrl: "postgres://localhost/db",
          supabaseServiceRoleKey: "sb_service_role_xxx",
        },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/supabaseUrl/);
  });

  test("throws on missing supabaseServiceRoleKey in production", () => {
    expect(() =>
      parseSyntropyConfig(
        {
          syntropyBaseUrl: "https://api.syntropy.example",
          databaseUrl: "postgres://localhost/db",
          supabaseUrl: "https://x.supabase.co",
        },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/supabaseServiceRoleKey/);
  });

  test("rejects non-URL supabaseUrl", () => {
    expect(() =>
      parseSyntropyConfig(
        {
          syntropyBaseUrl: "https://api.syntropy.example",
          databaseUrl: "postgres://localhost/db",
          supabaseUrl: "not-a-url",
          supabaseServiceRoleKey: "sb_service_role_xxx",
        },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/supabaseUrl/);
  });
});
