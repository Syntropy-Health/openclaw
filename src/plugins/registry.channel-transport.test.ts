import { describe, expect, it } from "vitest";
import type { ChannelOutboundContext } from "../channels/plugins/types.adapters.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import { createPluginRegistry } from "./registry.js";

const send = async (_ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> => ({
  channel: "whatsapp",
  messageId: "x",
});

function harness() {
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const built = createPluginRegistry({ logger, runtime: {} as never });
  // registerChannelTransport only reads record.{id,source,channelTransports}.
  const apiFor = (id: string) =>
    built.createApi({ id, source: `test:${id}`, channelTransports: [] } as never, {
      config: {} as never,
    });
  return { registry: built.registry, apiFor };
}

describe("registerChannelTransport primitive", () => {
  it("registers a valid channel/transport", () => {
    const { registry, apiFor } = harness();
    apiFor("kapso").registerChannelTransport({ channel: "whatsapp", transport: "kapso", send });
    expect(registry.channelTransports).toHaveLength(1);
    expect(registry.channelTransports[0]).toMatchObject({
      channel: "whatsapp",
      transport: "kapso",
    });
    expect(registry.channelTransports[0].send).toBe(send);
    expect(registry.diagnostics.filter((d) => d.level === "error")).toHaveLength(0);
  });

  it("★ rejects a missing send/channel/transport with an error diagnostic (no entry)", () => {
    const { registry, apiFor } = harness();
    apiFor("bad").registerChannelTransport({
      channel: "whatsapp",
      transport: "",
      send,
    } as never);
    apiFor("bad2").registerChannelTransport({
      channel: "whatsapp",
      transport: "kapso",
      send: undefined,
    } as never);
    expect(registry.channelTransports).toHaveLength(0);
    expect(
      registry.diagnostics.filter((d) => d.level === "error" && d.message.includes("requires")),
    ).toHaveLength(2);
  });

  it("★ FIRST-WINS: a second plugin claiming the same channel/transport is REJECTED (original kept)", () => {
    const { registry, apiFor } = harness();
    const send2 = async (): Promise<OutboundDeliveryResult> => ({
      channel: "whatsapp",
      messageId: "2",
    });
    apiFor("first").registerChannelTransport({ channel: "whatsapp", transport: "kapso", send });
    apiFor("second").registerChannelTransport({
      channel: "whatsapp",
      transport: "kapso",
      send: send2,
    });
    expect(registry.channelTransports).toHaveLength(1);
    expect(registry.channelTransports[0].send).toBe(send); // first wins, NOT overridden
    expect(registry.channelTransports[0].pluginId).toBe("first");
    expect(
      registry.diagnostics.filter(
        (d) => d.level === "error" && d.message.includes("already registered"),
      ),
    ).toHaveLength(1);
  });

  it("tracks the registration on the plugin record (introspection parity)", () => {
    const { registry, apiFor } = harness();
    apiFor("kapso").registerChannelTransport({ channel: "whatsapp", transport: "kapso", send });
    // distinct channel/transport from another plugin coexist
    apiFor("sig").registerChannelTransport({ channel: "signal", transport: "x", send });
    expect(registry.channelTransports).toHaveLength(2);
  });
});
