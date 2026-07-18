import { describe, expect, it } from "vitest";
import { isThirdPartyChannel } from "../../../src/infra/outbound/render-policy.js";
import kapsoWhatsappPlugin from "./index.js";

describe("B-Kapso-1 rails — PHI boundary", () => {
  it("'whatsapp' is a third-party channel → PHI-denied (nudge/CTA only, PHI in-app)", () => {
    expect(isThirdPartyChannel("whatsapp")).toBe(true);
  });
});

type Captured = { route: { path?: string } | null; hooks: string[] };

function fakeApi() {
  const captured: Captured = { route: null, hooks: [] };
  const api = {
    pluginConfig: {} as Record<string, unknown>,
    config: {} as Record<string, unknown>,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerHttpRoute: (params: unknown) => {
      captured.route = params as Captured["route"];
    },
    on: (name: string) => {
      captured.hooks.push(name);
    },
  };
  return { api, captured };
}

describe("B-Kapso-1 rails — register() wiring", () => {
  it("registers the '/kapso/whatsapp' webhook + a gateway_stop cleanup", async () => {
    const { api, captured } = fakeApi();
    // Force the no-DB branch so the test never opens a real pg connection.
    const savedDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await kapsoWhatsappPlugin.register(api as never);
    } finally {
      if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl;
    }
    expect(captured.route?.path).toBe("/kapso/whatsapp");
    expect(captured.hooks).toContain("gateway_stop");
  });
});
