/**
 * SEALED challenge suite — Phase C (τ-metering) config gating, contract §9.
 *
 * Category: functional/tau-config
 *
 * Challenges resolveGatewayAuth(...).tau against the §9 enablement contract:
 *   - tau is undefined by default (no config, no env) — behavior-preserving.
 *   - enabled via authConfig.tau.enabled === true OR env OPENCLAW_TAU_ENABLED
 *     in {"1","true"} (case-insensitive); NOT for "0"/"false"/blank/other.
 *   - numeric overrides: config takes precedence over env; positive integers
 *     only; blank/invalid env -> undefined (meter falls back to its defaults).
 *   - partial config (enabled with all-undefined numerics) still resolves.
 *
 * Depends only on the public resolveGatewayAuth signature — no server wiring.
 */

import { describe, expect, it } from "vitest";
import type { GatewayAuthConfig } from "../config/config.js";
import { resolveGatewayAuth } from "./auth.js";

function resolve(params: { authConfig?: GatewayAuthConfig; env?: NodeJS.ProcessEnv }) {
  // Always pass an explicit env to avoid leaking the ambient process.env.
  return resolveGatewayAuth({
    authConfig: params.authConfig,
    env: params.env ?? {},
  });
}

describe("functional/tau-config — resolveGatewayAuth().tau gating (contract §9)", () => {
  it("is undefined by default (no config, no env) — behavior-preserving no-op", () => {
    expect(resolve({}).tau).toBeUndefined();
    expect(resolve({ authConfig: {} }).tau).toBeUndefined();
    expect(resolve({ authConfig: { tau: {} } }).tau).toBeUndefined();
    expect(resolve({ authConfig: { tau: { enabled: false } } }).tau).toBeUndefined();
  });

  it("enables via authConfig.tau.enabled === true", () => {
    const tau = resolve({ authConfig: { tau: { enabled: true } } }).tau;
    expect(tau).toBeDefined();
    // With no numerics supplied, the fields are undefined so the meter uses
    // its OWN defaults (partial config still resolves).
    expect(tau).toEqual({
      maxCostPerWindow: undefined,
      windowMs: undefined,
      retryAfterMs: undefined,
    });
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["True", true],
    ["  true  ", true],
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["", false],
    ["   ", false],
    ["yes", false],
    ["2", false],
    ["enabled", false],
  ])("OPENCLAW_TAU_ENABLED=%j -> enabled=%s", (raw, shouldEnable) => {
    const tau = resolve({ env: { OPENCLAW_TAU_ENABLED: raw } }).tau;
    if (shouldEnable) {
      expect(tau).toBeDefined();
    } else {
      expect(tau).toBeUndefined();
    }
  });

  it("config.enabled=false wins even when env would enable (explicit opt-out)", () => {
    const tau = resolve({
      authConfig: { tau: { enabled: false } },
      env: { OPENCLAW_TAU_ENABLED: "1" },
    }).tau;
    expect(tau).toBeUndefined();
  });

  it("numeric overrides from config take precedence over env", () => {
    const tau = resolve({
      authConfig: {
        tau: {
          enabled: true,
          maxCostPerWindow: 7,
          windowMs: 1234,
          retryAfterMs: 5678,
        },
      },
      env: {
        OPENCLAW_TAU_MAX_COST_PER_WINDOW: "999",
        OPENCLAW_TAU_WINDOW_MS: "888",
        OPENCLAW_TAU_RETRY_AFTER_MS: "777",
      },
    }).tau;
    expect(tau).toEqual({ maxCostPerWindow: 7, windowMs: 1234, retryAfterMs: 5678 });
  });

  it("numeric values come from env when config omits them (enabled via config)", () => {
    const tau = resolve({
      authConfig: { tau: { enabled: true } },
      env: {
        OPENCLAW_TAU_MAX_COST_PER_WINDOW: "42",
        OPENCLAW_TAU_WINDOW_MS: "30000",
        OPENCLAW_TAU_RETRY_AFTER_MS: "15000",
      },
    }).tau;
    expect(tau).toEqual({ maxCostPerWindow: 42, windowMs: 30000, retryAfterMs: 15000 });
  });

  it("numeric values come from env when enabled via env", () => {
    const tau = resolve({
      env: {
        OPENCLAW_TAU_ENABLED: "true",
        OPENCLAW_TAU_MAX_COST_PER_WINDOW: "10",
        OPENCLAW_TAU_WINDOW_MS: "20",
        OPENCLAW_TAU_RETRY_AFTER_MS: "30",
      },
    }).tau;
    expect(tau).toEqual({ maxCostPerWindow: 10, windowMs: 20, retryAfterMs: 30 });
  });

  it.each([
    ["blank", ""],
    ["whitespace", "   "],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
    ["float", "1.5"],
    ["trailing junk", "10x"],
  ])("invalid numeric env (%s) -> field undefined (meter uses its own default)", (_label, bad) => {
    const tau = resolve({
      env: {
        OPENCLAW_TAU_ENABLED: "1",
        OPENCLAW_TAU_MAX_COST_PER_WINDOW: bad,
        OPENCLAW_TAU_WINDOW_MS: bad,
        OPENCLAW_TAU_RETRY_AFTER_MS: bad,
      },
    }).tau;
    expect(tau).toBeDefined();
    expect(tau).toEqual({
      maxCostPerWindow: undefined,
      windowMs: undefined,
      retryAfterMs: undefined,
    });
  });

  it("partial config: enabled with only some numerics resolves the rest to undefined", () => {
    const tau = resolve({
      authConfig: { tau: { enabled: true, maxCostPerWindow: 3 } },
      env: {},
    }).tau;
    expect(tau).toEqual({
      maxCostPerWindow: 3,
      windowMs: undefined,
      retryAfterMs: undefined,
    });
  });

  it("enabling tau does not disturb other resolved auth fields", () => {
    const resolved = resolve({
      authConfig: { mode: "token", token: "secret", tau: { enabled: true } },
    });
    expect(resolved.mode).toBe("token");
    expect(resolved.token).toBe("secret");
    expect(resolved.tau).toBeDefined();
  });
});
