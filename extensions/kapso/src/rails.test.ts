import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { isThirdPartyChannel } from "../../../src/infra/outbound/render-policy.js";
import { type OptOutStore } from "../../twilio/src/compliance.js";
import kapsoWhatsappPlugin, { createKapsoOnInbound, FAIL_CLOSED_STORE } from "./index.js";
import { type ResolvedKapsoConfig } from "./kapso-config.js";

describe("B-Kapso-1 rails — PHI boundary", () => {
  it("'whatsapp' is a third-party channel → PHI-denied (nudge/CTA only, PHI in-app)", () => {
    expect(isThirdPartyChannel("whatsapp")).toBe(true);
  });
});

const RESOLVED: ResolvedKapsoConfig = {
  apiKey: "k",
  baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
  phoneNumberId: "PN_1",
  appSecret: "s",
  inbound: "pairing",
  allowFrom: [],
};

function memStore(seed: string[] = []): OptOutStore & { set: Set<string> } {
  const set = new Set(seed);
  return {
    set,
    isOptedOut: (n) => set.has(n),
    optOut: (n) => void set.add(n),
    optIn: (n) => void set.delete(n),
  };
}

const KAPSO_CFG = {
  channels: { whatsapp: { transport: "kapso" } },
} as unknown as OpenClawConfig;

describe("createKapsoOnInbound — QG-M4 wiring (the actual regression site)", () => {
  it("★ a null phone-number-id does NOT drop a STOP — compliance is recorded, dispatch not called", async () => {
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    const onInbound = createKapsoOnInbound({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => null, // send target unresolved
      store,
      cfg: KAPSO_CFG,
      logger: { warn: () => {}, error: () => {} },
      dispatch,
    });
    await onInbound({ from: "+15557654321", body: "STOP" });
    expect(store.set.has("+15557654321")).toBe(true); // NOT dropped despite null pnid
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("★ QG-M3 gate: inbound is a NO-OP when whatsapp transport is not 'kapso'", async () => {
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    const onInbound = createKapsoOnInbound({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      cfg: { channels: { whatsapp: { transport: "baileys" } } } as unknown as OpenClawConfig,
      logger: { info: () => {} },
      dispatch,
    });
    await onInbound({ from: "+15557654321", body: "STOP" });
    expect(store.set.size).toBe(0); // gated out — not processed
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("QG-M3 gate: inbound is a NO-OP when transport is OMITTED (undefined ≠ kapso)", async () => {
    const store = memStore();
    const onInbound = createKapsoOnInbound({
      resolveConfig: () => RESOLVED,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      cfg: {} as OpenClawConfig, // no channels.whatsapp.transport
      logger: { info: () => {} },
      dispatch: vi.fn(async () => {}),
    });
    await onInbound({ from: "+15557654321", body: "STOP" });
    expect(store.set.size).toBe(0);
  });

  it("an inert config (resolveConfig → null) is a silent no-op", async () => {
    const store = memStore();
    const dispatch = vi.fn(async () => {});
    const onInbound = createKapsoOnInbound({
      resolveConfig: () => null,
      resolvePhoneNumberId: async () => "PN_1",
      store,
      cfg: {} as OpenClawConfig,
      dispatch,
    });
    await onInbound({ from: "+15557654321", body: "STOP" });
    expect(store.set.size).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("B-Kapso-1 rails — fail-closed opt-out store", () => {
  it("the no-DB store throws on read → every guarded send is suppressed (fail-closed)", () => {
    // This is the store the plugin installs when DATABASE_URL is absent. A throwing
    // isOptedOut is the fail-closed contract guardedSendKapso relies on.
    expect(() => FAIL_CLOSED_STORE.isOptedOut("+15557654321")).toThrow();
  });
});

type Captured = {
  route: { path?: string } | null;
  hooks: string[];
  transports: Array<{ channel: string; transport: string; hasSend: boolean }>;
};

function fakeApi() {
  const captured: Captured = { route: null, hooks: [], transports: [] };
  const warns: string[] = [];
  const api = {
    pluginConfig: {} as Record<string, unknown>,
    config: {} as Record<string, unknown>,
    logger: { info: () => {}, warn: (m: string) => warns.push(m), error: () => {} },
    registerHttpRoute: (params: unknown) => {
      captured.route = params as Captured["route"];
    },
    registerChannelTransport: (r: { channel: string; transport: string; send: unknown }) => {
      captured.transports.push({
        channel: r.channel,
        transport: r.transport,
        hasSend: typeof r.send === "function",
      });
    },
    on: (name: string) => {
      captured.hooks.push(name);
    },
  };
  return { api, captured, warns };
}

describe("B-Kapso-1 rails — register() wiring", () => {
  it("registers the '/kapso/whatsapp' webhook + a gateway_stop cleanup, warns fail-closed with no DB", async () => {
    const { api, captured, warns } = fakeApi();
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
    // Registers the whatsapp/kapso OUTBOUND transport via the plugin primitive.
    expect(captured.transports).toContainEqual({
      channel: "whatsapp",
      transport: "kapso",
      hasSend: true,
    });
    // No DB → the fail-closed store is installed, and the operator is warned.
    expect(warns.some((m) => m.includes("fail-closed"))).toBe(true);
  });
});
