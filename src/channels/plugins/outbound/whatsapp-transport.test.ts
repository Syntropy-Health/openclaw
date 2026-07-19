import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.js";
import type { OutboundDeliveryResult } from "../../../infra/outbound/deliver.js";
import {
  clearWhatsAppOutboundTransports,
  registerWhatsAppOutboundTransport,
  selectWhatsAppOutboundTransport,
  WhatsAppTransportUnavailableError,
} from "./whatsapp-transport.js";
import { whatsappOutbound } from "./whatsapp.js";

const cfg = (transport?: string): OpenClawConfig =>
  ({ channels: { whatsapp: transport ? { transport } : {} } }) as unknown as OpenClawConfig;

const stubSend = async (): Promise<OutboundDeliveryResult> => ({
  channel: "whatsapp",
  messageId: "stub",
});

describe("whatsapp outbound transport registry (B-Kapso slice 3b)", () => {
  beforeEach(() => clearWhatsAppOutboundTransports());

  it("selects null for the default/baileys transport (Baileys path unchanged)", () => {
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
    registerWhatsAppOutboundTransport("kapso", stubSend);
    expect(selectWhatsAppOutboundTransport(cfg("kapso"))).toBe(stubSend);
    // a default selection never picks up the kapso send
    expect(selectWhatsAppOutboundTransport(cfg("baileys"))).toBeNull();
  });

  it("warns on re-registration of a claimed name (collision is observable)", () => {
    const warn = vi.fn();
    registerWhatsAppOutboundTransport("kapso", stubSend, { warn });
    expect(warn).not.toHaveBeenCalled();
    const other = async (): Promise<OutboundDeliveryResult> => ({
      channel: "whatsapp",
      messageId: "2",
    });
    registerWhatsAppOutboundTransport("kapso", other, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(selectWhatsAppOutboundTransport(cfg("kapso"))).toBe(other); // last wins
  });

  it("clear() removes registrations (fail-closed again)", () => {
    registerWhatsAppOutboundTransport("kapso", stubSend);
    clearWhatsAppOutboundTransports();
    expect(() => selectWhatsAppOutboundTransport(cfg("kapso"))).toThrow(
      WhatsAppTransportUnavailableError,
    );
  });
});

describe("whatsappOutbound.sendText — core adapter transport delegation", () => {
  beforeEach(() => clearWhatsAppOutboundTransports());

  it("★ delegates to the registered transport when selected, NOT the Baileys deps.send", async () => {
    const kapso = vi.fn(stubSend);
    registerWhatsAppOutboundTransport("kapso", kapso);
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
    registerWhatsAppOutboundTransport("kapso", kapso);
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
});
