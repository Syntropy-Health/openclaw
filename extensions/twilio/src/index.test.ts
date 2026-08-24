/**
 * #223 — the SMS surface is inert BY CONSTRUCTION, not by credential absence.
 *
 * THE ACCIDENT THIS PREVENTS (CTO ruling #7057): before this gate, the
 * channel was "inert until credential-complete" — so provisioning Twilio
 * credentials for ANY unrelated reason would activate an unowned SMS
 * transport that policy has ruled out of scope. The red arm below is the
 * ruling's own acceptance test: FULL VALID CREDENTIALS PROVISIONED, and the
 * surface must still refuse — the guard observed firing on exactly the
 * accident it prevents.
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

describe("#223 — constructive disable [PRINCIPAL-RULED 2026-08-21]", () => {
  it("RED ARM: full valid credentials provisioned → the surface STILL refuses", async () => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(FULL_CREDS_ENV)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const { api, logs, registered } = fakeApi(); // no override flag
      await twilioSmsPlugin.register(api);

      // The accident, prevented: nothing registered, despite credentials.
      expect(registered.channels).toBe(0);
      expect(registered.routes).toBe(0);
      // The refusal is LOUD and carries the ruling label — greppable basis,
      // not silence (a silent disable reads as "nothing to report").
      const line = logs.info.join("\n");
      expect(line).toContain("DISABLED BY CONSTRUCTION");
      expect(line).toContain("PRINCIPAL-RULED 2026-08-21");
      expect(line).toContain("regardless of credentials");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the disable is the FLAG, not breakage: the named override registers the surface (and warns)", async () => {
    // The reversibility half of the ruling: a labeled disable, not a broken
    // extension. The flag name is the acknowledgement — enabling requires
    // writing the ruling into config.
    const { api, logs, registered } = fakeApi({ enableDespiteSmsOutOfScopeRuling: true });
    await twilioSmsPlugin.register(api);

    expect(registered.channels).toBe(1);
    expect(registered.routes).toBe(1);
    expect(logs.warn.join("\n")).toContain("ACTIVE against");
  });

  it("a truthy-but-not-true flag value does NOT enable (fail-closed on sloppy config)", async () => {
    for (const bad of ["true", 1, "yes"]) {
      const { api, registered } = fakeApi({ enableDespiteSmsOutOfScopeRuling: bad });
      await twilioSmsPlugin.register(api);
      expect(registered.channels, String(bad)).toBe(0);
      expect(registered.routes, String(bad)).toBe(0);
    }
  });
});
