import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("REJECTS gateway.auth.clerk: Clerk trust anchors are env-only (not config.patch-writable)", () => {
    // gateway.auth is .strict(). Keeping clerk OUT of the schema means the JWKS
    // URL / issuer / audience / azp allow-list cannot be changed through
    // config.patch, which the agent's own gateway tool can call (prompt-injection
    // path to swapping the JWKS). Operators set OPENCLAW_CLERK_* env instead.
    for (const clerk of [
      {
        jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
        issuer: "https://clerk.example.test",
        audience: "openclaw",
      },
      { authorizedParties: ["https://shrinelongevity.com"], allowMissingAzp: true },
    ]) {
      const res = validateConfigObject({ gateway: { auth: { clerk } } });
      expect(res.ok).toBe(false);
    }
  });

  it("accepts gateway.channelHealthCheckMinutes (strict-schema gap regression)", () => {
    // The field exists on GatewayConfig (types.gateway.ts) and is honored at
    // runtime, but was missing from the .strict() gateway zod object — so any
    // config that set it failed strict validation. Pin that it validates.
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 10,
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts gateway.channelHealthCheckMinutes = 0 (disable sentinel)", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: 0,
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects negative gateway.channelHealthCheckMinutes", () => {
    const res = validateConfigObject({
      gateway: {
        channelHealthCheckMinutes: -1,
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts gateway.http.endpoints.responses.turnTimeoutMs (issue #112)", () => {
    const res = validateConfigObject({
      gateway: { http: { endpoints: { responses: { enabled: true, turnTimeoutMs: 120000 } } } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts responses.turnTimeoutMs = 0 (disable sentinel)", () => {
    const res = validateConfigObject({
      gateway: { http: { endpoints: { responses: { turnTimeoutMs: 0 } } } },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects negative responses.turnTimeoutMs", () => {
    const res = validateConfigObject({
      gateway: { http: { endpoints: { responses: { turnTimeoutMs: -1 } } } },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts gateway.customBindHost (strict-schema gap regression)", () => {
    // Read at runtime (server-runtime-config.ts) + on the GatewayConfig type, but
    // was missing from the strict gateway zod object — so `gateway.bind: 'custom'`
    // with a customBindHost failed validation. Pin that it validates.
    const res = validateConfigObject({
      gateway: { bind: "custom", customBindHost: "0.0.0.0" },
    });
    expect(res.ok).toBe(true);
  });
});
