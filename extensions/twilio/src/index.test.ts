/**
 * SYN-272 R1 (renamed from #223) — the SMS surface is explicit-enable BY
 * CONSTRUCTION, not credential-activated.
 *
 * THE ACCIDENT THIS PREVENTS (unchanged across the supersession): the
 * channel must never be "inert until credential-complete" — provisioning
 * Twilio credentials for ANY unrelated reason must not activate the
 * transport. The red arm is the same acceptance test #223 shipped: FULL
 * VALID CREDENTIALS PROVISIONED, and the surface still refuses without the
 * flag. What changed under SYN-272 [PRINCIPAL-RULED 2026-08-27]: the flag
 * is now `smsEnabled` (funding the surface is sanctioned policy, not an
 * against-the-ruling override), and the enabled path logs INFO, not WARN.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import twilioSmsPlugin from "./index.js";

/** Full, VALID credential env — the "someone provisioned Twilio" state. */
const FULL_CREDS_ENV = {
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000001",
  TWILIO_API_KEY_SECRET: "secret-secret-secret",
  TWILIO_AUTH_TOKEN: "auth-token-auth-token",
  TWILIO_FROM_NUMBER: "+15551230001",
};

function fakeApi(pluginConfig: Record<string, unknown> = {}) {
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const registered = { channels: 0, routes: 0 };
  const api = {
    id: "twilio",
    config: { channels: { sms: FULL_CREDS_ENV } },
    pluginConfig,
    logger: {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
    },
    registerChannel: vi.fn(() => {
      registered.channels += 1;
    }),
    registerHttpRoute: vi.fn(() => {
      registered.routes += 1;
    }),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  return { api, logs, registered };
}

describe("SYN-272 R1 — explicit-enable by construction (supersedes #223's ruling basis)", () => {
  it("RED ARM: full valid credentials provisioned → the surface STILL refuses", async () => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(FULL_CREDS_ENV)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const { api, logs, registered } = fakeApi(); // no enable flag
      await twilioSmsPlugin.register(api);

      // The accident, prevented: nothing registered, despite credentials.
      expect(registered.channels).toBe(0);
      expect(registered.routes).toBe(0);
      // The refusal is LOUD and carries the ruling label — greppable basis,
      // not silence (a silent disable reads as "nothing to report").
      const line = logs.info.join("\n");
      expect(line).toContain("NOT ENABLED");
      expect(line).toContain("SYN-272 R1");
      expect(line).toContain("regardless of credentials");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the disable is the FLAG, not breakage: smsEnabled registers the surface with an INFO (not WARN)", async () => {
    // Post-supersession: enabling is sanctioned policy (SYN-272), so the
    // active path is INFO-level and cites the ruling; the WARN-shaped
    // "ACTIVE against the ruling" line is gone WITH its ruling.
    const { api, logs, registered } = fakeApi({ smsEnabled: true });
    await twilioSmsPlugin.register(api);

    expect(registered.channels).toBe(1);
    expect(registered.routes).toBe(1);
    expect(logs.info.join("\n")).toContain("ACTIVE under SYN-272");
    expect(logs.warn.join("\n")).not.toContain("ACTIVE against");
  });

  it("the RETIRED #223 flag name no longer enables anything (a rename, not an alias)", async () => {
    // Two names for one gate would be two truths that can disagree; the old
    // name must be dead, not deprecated.
    const { api, registered } = fakeApi({ enableDespiteSmsOutOfScopeRuling: true });
    await twilioSmsPlugin.register(api);
    expect(registered.channels).toBe(0);
    expect(registered.routes).toBe(0);
  });

  it("a truthy-but-not-true flag value does NOT enable (fail-closed on sloppy config)", async () => {
    for (const bad of ["true", 1, "yes"]) {
      const { api, registered } = fakeApi({ smsEnabled: bad });
      await twilioSmsPlugin.register(api);
      expect(registered.channels, String(bad)).toBe(0);
      expect(registered.routes, String(bad)).toBe(0);
    }
  });
});
