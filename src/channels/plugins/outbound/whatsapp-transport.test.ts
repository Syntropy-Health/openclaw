import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../../../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../../plugins/runtime.js";
import type { ChannelOutboundTransport } from "../types.adapters.js";
import {
  selectWhatsAppOutboundTransport,
  WhatsAppTransportUnavailableError,
} from "./whatsapp-transport.js";
import { whatsappOutbound } from "./whatsapp.js";

const cfg = (transport?: string): OpenClawConfig =>
  ({ channels: { whatsapp: transport ? { transport } : {} } }) as unknown as OpenClawConfig;

const stubSend: ChannelOutboundTransport = async () => ({ channel: "whatsapp", messageId: "stub" });

/** Set the active registry to one carrying the given whatsapp transports. */
function setRegistry(transports: Array<{ transport: string; send: ChannelOutboundTransport }>) {
  const reg = createEmptyPluginRegistry();
  for (const t of transports) {
    reg.channelTransports.push({
      pluginId: "test",
      channel: "whatsapp",
      transport: t.transport,
      send: t.send,
      source: "test",
    });
  }
  setActivePluginRegistry(reg);
}

let saved: PluginRegistry | null;
beforeEach(() => {
  saved = getActivePluginRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterEach(() => {
  setActivePluginRegistry(saved ?? createEmptyPluginRegistry());
});

describe("selectWhatsAppOutboundTransport (B-Kapso — registry-backed)", () => {
  it("returns null for the default/baileys transport (Baileys path unchanged)", () => {
    expect(selectWhatsAppOutboundTransport(cfg())).toBeNull();
    expect(selectWhatsAppOutboundTransport(cfg("baileys"))).toBeNull();
    expect(selectWhatsAppOutboundTransport(undefined)).toBeNull();
  });

  it("★ FAILS CLOSED when a non-baileys transport is selected but unregistered (no silent baileys)", () => {
    expect(() => selectWhatsAppOutboundTransport(cfg("kapso"))).toThrow(
      WhatsAppTransportUnavailableError,
    );
  });

  it("returns the registered send for the selected transport only", () => {
    setRegistry([{ transport: "kapso", send: stubSend }]);
    expect(selectWhatsAppOutboundTransport(cfg("kapso"))).toBe(stubSend);
    expect(selectWhatsAppOutboundTransport(cfg("baileys"))).toBeNull();
  });

  it("★ inherits registry lifecycle — a registry swap that drops the transport re-fail-closes", () => {
    setRegistry([{ transport: "kapso", send: stubSend }]);
    expect(selectWhatsAppOutboundTransport(cfg("kapso"))).toBe(stubSend);
    setActivePluginRegistry(createEmptyPluginRegistry()); // e.g. reload/unload
    expect(() => selectWhatsAppOutboundTransport(cfg("kapso"))).toThrow(
      WhatsAppTransportUnavailableError,
    );
  });
});

describe("whatsappOutbound.sendText — core adapter transport delegation", () => {
  it("★ delegates to the registered transport when selected, NOT the Baileys deps.send", async () => {
    const kapso = vi.fn(stubSend);
    setRegistry([{ transport: "kapso", send: kapso }]);
    const sendWhatsApp = vi.fn();
    const res = await whatsappOutbound.sendText?.({
      cfg: cfg("kapso"),
      to: "15557654321@s.whatsapp.net",
      text: "nudge",
      deps: { sendWhatsApp } as never,
    } as never);
    expect(kapso).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(res?.messageId).toBe("stub");
  });

  it("★ uses the Baileys deps.send on the default (baileys) transport — unchanged", async () => {
    const kapso = vi.fn(stubSend);
    setRegistry([{ transport: "kapso", send: kapso }]);
    const sendWhatsApp = vi.fn(async () => ({ messageId: "baileys-1" }));
    await whatsappOutbound.sendText?.({
      cfg: cfg(), // default → baileys
      to: "15557654321@s.whatsapp.net",
      text: "hi",
      deps: { sendWhatsApp } as never,
    } as never);
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(kapso).not.toHaveBeenCalled();
  });

  it("★ PROPAGATES the fail-closed throw — never falls back to Baileys when kapso unregistered", async () => {
    const sendWhatsApp = vi.fn();
    await expect(
      whatsappOutbound.sendText?.({
        cfg: cfg("kapso"), // selected but nothing registered
        to: "15557654321@s.whatsapp.net",
        text: "nudge",
        deps: { sendWhatsApp } as never,
      } as never),
    ).rejects.toThrow(WhatsAppTransportUnavailableError);
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });
});
