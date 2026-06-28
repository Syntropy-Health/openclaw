/**
 * Unit tests for service-auth config resolution (openclaw → SJ /mcp M2M).
 *
 * Contract (P2 wire contract, AND.md §"P2 — Multi-app authorization"):
 *  - `resource` is REQUIRED and must be a parseable URL — it becomes the M2M
 *    `resource` claim and MUST equal SJ's validated /mcp URI byte-for-byte.
 *  - `resource` may come from env (SYNTROPY_MCP_RESOURCE_URL) or pluginConfig.
 *  - machine secret is read from CLERK_MACHINE_SECRET_KEY; absent => undefined.
 *  - clerk API base defaults to BAPI, overridable via CLERK_API_URL.
 */

import { describe, test, expect } from "vitest";
import {
  resolveServiceAuthConfig,
  DEFAULT_CLERK_API_URL,
  ServiceAuthConfigError,
} from "./service-auth-config.js";

const SJ_TEST_MCP = "https://shrine-api-test.up.railway.app/mcp";
const SJ_PROD_MCP = "https://shrine-api-production.up.railway.app/mcp";

describe("resolveServiceAuthConfig", () => {
  test("resolves resource from pluginConfig and secret from env", () => {
    const cfg = resolveServiceAuthConfig(
      { resource: SJ_TEST_MCP },
      { NODE_ENV: "production", CLERK_MACHINE_SECRET_KEY: "ak_test_123" },
    );
    expect(cfg.resource).toBe(SJ_TEST_MCP);
    expect(cfg.machineSecretKey).toBe("ak_test_123");
    expect(cfg.isProduction).toBe(true);
    expect(cfg.clerkApiUrl).toBe(DEFAULT_CLERK_API_URL);
  });

  test("env SYNTROPY_MCP_RESOURCE_URL wins over pluginConfig.resource", () => {
    const cfg = resolveServiceAuthConfig(
      { resource: SJ_TEST_MCP },
      {
        NODE_ENV: "production",
        CLERK_MACHINE_SECRET_KEY: "ak_x",
        SYNTROPY_MCP_RESOURCE_URL: SJ_PROD_MCP,
      },
    );
    expect(cfg.resource).toBe(SJ_PROD_MCP);
  });

  test("resource is preserved exactly — no trailing-slash normalization", () => {
    // The SJ validator compares the resource claim to its canonical /mcp URI
    // exactly; normalizing here would silently break the audience check.
    const withSlash = "https://shrine-api-test.up.railway.app/mcp/";
    const cfg = resolveServiceAuthConfig(
      { resource: withSlash },
      { CLERK_MACHINE_SECRET_KEY: "ak_x" },
    );
    expect(cfg.resource).toBe(withSlash);
  });

  test("per-env: test vs prod resolve distinct canonical resource URIs", () => {
    const test = resolveServiceAuthConfig(
      {},
      { SYNTROPY_MCP_RESOURCE_URL: SJ_TEST_MCP, CLERK_MACHINE_SECRET_KEY: "ak_t" },
    );
    const prod = resolveServiceAuthConfig(
      {},
      {
        NODE_ENV: "production",
        SYNTROPY_MCP_RESOURCE_URL: SJ_PROD_MCP,
        CLERK_MACHINE_SECRET_KEY: "ak_p",
      },
    );
    expect(test.resource).toBe(SJ_TEST_MCP);
    expect(prod.resource).toBe(SJ_PROD_MCP);
    expect(test.resource).not.toBe(prod.resource);
  });

  test("missing resource throws (no unsafe default)", () => {
    expect(() => resolveServiceAuthConfig({}, { CLERK_MACHINE_SECRET_KEY: "ak_x" })).toThrow(
      /missing `resource`/,
    );
  });

  test("non-URL resource throws", () => {
    expect(() =>
      resolveServiceAuthConfig({ resource: "not a url" }, { CLERK_MACHINE_SECRET_KEY: "ak_x" }),
    ).toThrow(/parseable URL/);
  });

  test("F11: missing vs malformed resource are distinguishable by reason", () => {
    // missing-resource is benign (machine path not configured).
    try {
      resolveServiceAuthConfig({}, { CLERK_MACHINE_SECRET_KEY: "ak_x" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceAuthConfigError);
      expect((e as ServiceAuthConfigError).reason).toBe("missing-resource");
    }
    // invalid-resource is a real misconfig (present but malformed).
    try {
      resolveServiceAuthConfig({ resource: "not a url" }, { CLERK_MACHINE_SECRET_KEY: "ak_x" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceAuthConfigError);
      expect((e as ServiceAuthConfigError).reason).toBe("invalid-resource");
    }
  });

  test("F2: non-https / unparseable CLERK_API_URL throws (secret-bearing URL is validated)", () => {
    for (const bad of ["http://clerk.example.com", "not-a-url", "ftp://x/y"]) {
      try {
        resolveServiceAuthConfig(
          { resource: SJ_TEST_MCP },
          { CLERK_MACHINE_SECRET_KEY: "ak_x", CLERK_API_URL: bad },
        );
        throw new Error(`expected throw for ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceAuthConfigError);
        expect((e as ServiceAuthConfigError).reason).toBe("invalid-clerk-api-url");
      }
    }
  });

  test("absent machine secret => machineSecretKey undefined (provider gates fail-closed)", () => {
    const cfg = resolveServiceAuthConfig({ resource: SJ_TEST_MCP }, { NODE_ENV: "production" });
    expect(cfg.machineSecretKey).toBeUndefined();
  });

  test("empty-string machine secret is treated as absent", () => {
    const cfg = resolveServiceAuthConfig(
      { resource: SJ_TEST_MCP },
      { CLERK_MACHINE_SECRET_KEY: "" },
    );
    expect(cfg.machineSecretKey).toBeUndefined();
  });

  test("CLERK_API_URL override is honored and trailing slash stripped", () => {
    const cfg = resolveServiceAuthConfig(
      { resource: SJ_TEST_MCP },
      { CLERK_MACHINE_SECRET_KEY: "ak_x", CLERK_API_URL: "https://clerk.example.com/" },
    );
    expect(cfg.clerkApiUrl).toBe("https://clerk.example.com");
  });
});
