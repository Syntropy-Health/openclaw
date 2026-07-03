import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { chatServiceSidecarEnabled, resolveChatServiceMode } from "./chat-service-mode.js";

const cfg = (gateway?: OpenClawConfig["gateway"]): Pick<OpenClawConfig, "gateway"> => ({ gateway });

describe("resolveChatServiceMode", () => {
  it("defaults to channels enabled (byte-identical to full gateway)", () => {
    const result = resolveChatServiceMode({ cfg: cfg(), env: {} });
    expect(result.channelsEnabled).toBe(true);
    // No companion defaults applied in full-gateway shape.
    expect(result.controlUiEnabledDefault).toBeUndefined();
    expect(result.openResponsesEnabledDefault).toBeUndefined();
  });

  it("treats gateway.runMode='chat-service' as channels-off + companion defaults", () => {
    const result = resolveChatServiceMode({
      cfg: cfg({ runMode: "chat-service" }),
      env: {},
    });
    expect(result.channelsEnabled).toBe(false);
    expect(result.controlUiEnabledDefault).toBe(false);
    expect(result.openResponsesEnabledDefault).toBe(true);
  });

  it("keeps channels on for gateway.runMode='full'", () => {
    const result = resolveChatServiceMode({ cfg: cfg({ runMode: "full" }), env: {} });
    expect(result.channelsEnabled).toBe(true);
  });

  it("OPENCLAW_CHANNELS_ENABLED=false forces channels-off + companion defaults", () => {
    const result = resolveChatServiceMode({
      cfg: cfg(),
      env: { OPENCLAW_CHANNELS_ENABLED: "false" },
    });
    expect(result.channelsEnabled).toBe(false);
    expect(result.controlUiEnabledDefault).toBe(false);
    expect(result.openResponsesEnabledDefault).toBe(true);
  });

  it("env primitive overrides runMode config (env true wins over chat-service)", () => {
    const result = resolveChatServiceMode({
      cfg: cfg({ runMode: "chat-service" }),
      env: { OPENCLAW_CHANNELS_ENABLED: "true" },
    });
    expect(result.channelsEnabled).toBe(true);
    // Channels back on ⇒ no companion defaults.
    expect(result.controlUiEnabledDefault).toBeUndefined();
    expect(result.openResponsesEnabledDefault).toBeUndefined();
  });

  it("env primitive false wins even when runMode is full", () => {
    const result = resolveChatServiceMode({
      cfg: cfg({ runMode: "full" }),
      env: { OPENCLAW_CHANNELS_ENABLED: "0" },
    });
    expect(result.channelsEnabled).toBe(false);
  });

  it("ignores an unparseable env value and falls back to runMode/default", () => {
    const result = resolveChatServiceMode({
      cfg: cfg({ runMode: "chat-service" }),
      env: { OPENCLAW_CHANNELS_ENABLED: "maybe" },
    });
    // Unparseable ⇒ env override ignored ⇒ runMode chat-service ⇒ off.
    expect(result.channelsEnabled).toBe(false);
  });
});

describe("chatServiceSidecarEnabled (issue #113 — lean chat-service sidecars)", () => {
  it("full gateway (channelsEnabled=true/undefined) → sidecar honored (true)", () => {
    expect(chatServiceSidecarEnabled(true, undefined)).toBe(true);
    expect(chatServiceSidecarEnabled(undefined, undefined)).toBe(true); // default = full
  });

  it("chat-service (channelsEnabled=false) → sidecar OFF unless explicitly opted in", () => {
    expect(chatServiceSidecarEnabled(false, undefined)).toBe(false);
    expect(chatServiceSidecarEnabled(false, false)).toBe(false);
    expect(chatServiceSidecarEnabled(false, true)).toBe(true); // explicit opt-in wins
  });

  it("full gateway ignores the opt-in (already on)", () => {
    expect(chatServiceSidecarEnabled(true, false)).toBe(true);
  });
});
