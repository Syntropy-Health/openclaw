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
      { syntropyBaseUrl: "https://api.syntropy.example", databaseUrl: "postgres://localhost/db" },
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
      { syntropyBaseUrl: "https://api.syntropy.example", databaseUrl: "postgres://explicit/db" },
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
});
