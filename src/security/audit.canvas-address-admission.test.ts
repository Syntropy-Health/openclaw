import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runSecurityAudit } from "./audit.js";

const CHECK = "gateway.canvas_address_admission_unverified";

async function findingFor(cfg: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  const res = await runSecurityAudit({
    config: cfg,
    env,
    includeFilesystem: false,
    includeChannelSecurity: false,
  });
  return res.findings.find((f) => f.checkId === CHECK);
}

const LAN: OpenClawConfig = {
  gateway: { bind: "lan", auth: { mode: "token", token: "a-long-enough-test-token-value" } },
};

describe("security audit: canvas host admission by client address", () => {
  it("warns for a non-loopback bind with the canvas host on and no trusted proxies", async () => {
    const finding = await findingFor(LAN);
    expect(finding).toEqual(
      expect.objectContaining({
        checkId: CHECK,
        severity: "warn",
        title: "Canvas host admits by client address",
      }),
    );
    expect(finding?.detail).toContain('gateway.bind="lan"');
    expect(finding?.remediation).toContain("gateway.trustedProxies");
    expect(finding?.remediation).toContain("OPENCLAW_CANVAS_ADDRESS_FALLBACK=off");
  });

  it("is quiet when trusted proxies are configured", async () => {
    expect(
      await findingFor({ gateway: { ...LAN.gateway, trustedProxies: ["10.0.0.5"] } }),
    ).toBeUndefined();
  });

  it("is quiet when the canvas host is disabled", async () => {
    expect(await findingFor({ ...LAN, canvasHost: { enabled: false } })).toBeUndefined();
  });

  it("is quiet on a loopback bind", async () => {
    expect(await findingFor({ gateway: { ...LAN.gateway, bind: "loopback" } })).toBeUndefined();
  });

  it("is quiet when the address fallback is already turned off", async () => {
    expect(await findingFor(LAN, { OPENCLAW_CANVAS_ADDRESS_FALLBACK: "off" })).toBeUndefined();
  });

  it("still warns when the variable is exactly on", async () => {
    expect(await findingFor(LAN, { OPENCLAW_CANVAS_ADDRESS_FALLBACK: "on" })).toBeDefined();
  });
});
