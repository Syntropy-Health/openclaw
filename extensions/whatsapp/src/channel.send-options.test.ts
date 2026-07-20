import { type ChannelOutboundTransport, type OpenClawConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Registry test-harness helpers are deliberately NOT on the public plugin-sdk
// (setActivePluginRegistry swaps the whole registry — a production footgun); a
// test may deep-import them directly.
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { whatsappPlugin } from "./channel.js";

// Mock runtime
const mockSendMessageWhatsApp = vi
  .fn()
  .mockResolvedValue({ messageId: "123", toJid: "123@s.whatsapp.net" });

vi.mock("./runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    channel: {
      text: { chunkText: (t: string) => [t] },
      whatsapp: {
        sendMessageWhatsApp: mockSendMessageWhatsApp,
        createLoginTool: vi.fn(),
      },
    },
    logging: { shouldLogVerbose: () => false },
  }),
}));

describe("whatsappPlugin.outbound.sendText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes linkPreview option to sendMessageWhatsApp", async () => {
    await whatsappPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "1234567890",
      text: "http://example.com",
      // @ts-expect-error - injecting extra param as per runtime behavior
      linkPreview: false,
    });

    expect(mockSendMessageWhatsApp).toHaveBeenCalledWith(
      "1234567890",
      "http://example.com",
      expect.objectContaining({
        linkPreview: false,
      }),
    );
  });

  it("passes linkPreview=undefined when omitted", async () => {
    await whatsappPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "1234567890",
      text: "hello",
    });

    expect(mockSendMessageWhatsApp).toHaveBeenCalledWith(
      "1234567890",
      "hello",
      expect.objectContaining({
        linkPreview: undefined,
      }),
    );
  });
});

describe("whatsappPlugin.outbound.sendText — transport selection (B-Kapso, registry-backed)", () => {
  let saved: ReturnType<typeof getActivePluginRegistry>;
  beforeEach(() => {
    vi.clearAllMocks();
    saved = getActivePluginRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  afterEach(() => setActivePluginRegistry(saved ?? createEmptyPluginRegistry()));

  const kapsoCfg = {
    channels: { whatsapp: { transport: "kapso" } },
  } as unknown as OpenClawConfig;

  function registerKapso(send: ChannelOutboundTransport) {
    const reg = createEmptyPluginRegistry();
    reg.channelTransports.push({
      pluginId: "kapso",
      channel: "whatsapp",
      transport: "kapso",
      send,
      source: "test",
    });
    setActivePluginRegistry(reg);
  }

  it("★ RUNTIME adapter routes to the registered kapso transport, NOT Baileys", async () => {
    const kapso = vi.fn(async () => ({ channel: "whatsapp" as const, messageId: "kapso-1" }));
    registerKapso(kapso);
    const res = await whatsappPlugin.outbound!.sendText!({
      cfg: kapsoCfg,
      to: "15557654321@s.whatsapp.net",
      text: "nudge",
    });
    expect(kapso).toHaveBeenCalledTimes(1);
    expect(mockSendMessageWhatsApp).not.toHaveBeenCalled();
    expect(res.messageId).toBe("kapso-1");
  });

  it("★ RUNTIME adapter uses Baileys on the default transport — unchanged", async () => {
    const kapso = vi.fn(async () => ({ channel: "whatsapp" as const, messageId: "kapso-1" }));
    registerKapso(kapso);
    await whatsappPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig, // default → baileys
      to: "1234567890",
      text: "hello",
    });
    expect(mockSendMessageWhatsApp).toHaveBeenCalledTimes(1);
    expect(kapso).not.toHaveBeenCalled();
  });

  it("★ RUNTIME adapter FAILS CLOSED when kapso selected but unregistered (no silent Baileys)", async () => {
    await expect(
      whatsappPlugin.outbound!.sendText!({
        cfg: kapsoCfg,
        to: "15557654321@s.whatsapp.net",
        text: "nudge",
      }),
    ).rejects.toThrow(/no provider is registered/);
    expect(mockSendMessageWhatsApp).not.toHaveBeenCalled();
  });

  it("sendMedia is NOT transport-routed in slice 3b (text-only) — still Baileys even in kapso mode", async () => {
    // Pins the deliberate slice-3b boundary: Kapso v1 is text-only, so media stays
    // on Baileys. Slice-4's cutover checklist must revisit media/poll parity.
    const kapso = vi.fn(async () => ({ channel: "whatsapp" as const, messageId: "kapso-1" }));
    registerKapso(kapso);
    await whatsappPlugin.outbound!.sendMedia!({
      cfg: kapsoCfg,
      to: "15557654321@s.whatsapp.net",
      text: "caption",
      mediaUrl: "https://example.com/a.jpg",
    });
    expect(mockSendMessageWhatsApp).toHaveBeenCalledTimes(1);
    expect(kapso).not.toHaveBeenCalled();
  });
});
