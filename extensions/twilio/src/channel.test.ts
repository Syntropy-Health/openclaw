import { describe, expect, it } from "vitest";
import { createSmsPlugin } from "./channel.js";
import { type OptOutStore } from "./compliance.js";

const store: OptOutStore = { isOptedOut: () => false, optOut: () => {}, optIn: () => {} };

describe("createSmsPlugin", () => {
  const plugin = createSmsPlugin({ store });

  it("is the 'sms' channel (vendor-agnostic id)", () => {
    expect(plugin.id).toBe("sms");
  });
  it("is direct-delivery with a text sender", () => {
    expect(plugin.outbound?.deliveryMode).toBe("direct");
    expect(typeof plugin.outbound?.sendText).toBe("function");
  });
  it("wires the SMS config adapter", () => {
    expect(typeof plugin.config.listAccountIds).toBe("function");
    expect(typeof plugin.config.resolveAccount).toBe("function");
  });
  it("declares direct chat only (no groups) and no media in v1", () => {
    expect(plugin.capabilities.chatTypes).toContain("direct");
    expect(plugin.capabilities.chatTypes).not.toContain("group");
    expect(plugin.capabilities.media).toBe(false);
  });
  it("has a human-facing meta label", () => {
    expect(plugin.meta.label.length).toBeGreaterThan(0);
    expect(plugin.meta.id).toBe("sms");
  });
});
