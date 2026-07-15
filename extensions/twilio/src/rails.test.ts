import { describe, expect, it } from "vitest";
import { isThirdPartyChannel } from "../../../src/infra/outbound/render-policy.js";
import twilioSmsPlugin from "./index.js";

describe("B-Twilio-1 rails — PHI boundary (slice 6)", () => {
  it("'sms' is a third-party channel → PHI-denied, can NEVER be phiApproved via plain config", () => {
    // The B5 deny-unknown posture: sms is not in FIRST_PARTY_PHI_CHANNELS, so
    // render-policy minimizes health egress to it. Nudge/CTA/nav only; PHI in-app.
    expect(isThirdPartyChannel("sms")).toBe(true);
  });
});

type Captured = {
  channel: { plugin?: { id?: string } } | null;
  route: { path?: string } | null;
  hooks: string[];
};

function fakeApi() {
  const captured: Captured = { channel: null, route: null, hooks: [] };
  const api = {
    pluginConfig: {} as Record<string, unknown>,
    config: {} as Record<string, unknown>,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerChannel: (reg: unknown) => {
      captured.channel = reg as Captured["channel"];
    },
    registerHttpRoute: (params: unknown) => {
      captured.route = params as Captured["route"];
    },
    on: (name: string) => {
      captured.hooks.push(name);
    },
  };
  return { api, captured };
}

describe("B-Twilio-1 rails — register() wiring (slice 6)", () => {
  it("registers the 'sms' channel, the '/twilio/sms' webhook, and a gateway_stop cleanup", async () => {
    const { api, captured } = fakeApi();
    // Force the no-DB branch so the test never opens a real pg connection.
    const savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await twilioSmsPlugin.register(api as never);
    } finally {
      if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
    }

    expect(captured.channel?.plugin?.id).toBe("sms");
    expect(captured.route?.path).toBe("/twilio/sms");
    expect(captured.hooks).toContain("gateway_stop");
  });
});
