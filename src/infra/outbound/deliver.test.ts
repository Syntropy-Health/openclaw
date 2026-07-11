import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalOutbound } from "../../channels/plugins/outbound/signal.js";
import { telegramOutbound } from "../../channels/plugins/outbound/telegram.js";
import { whatsappOutbound } from "../../channels/plugins/outbound/whatsapp.js";
import type { OpenClawConfig } from "../../config/config.js";
import { STATE_DIR } from "../../config/paths.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { markdownToSignalTextChunks } from "../../signal/format.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createIMessageTestPlugin } from "../../test-utils/imessage-test-plugin.js";

const mocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true, sessionFile: "x" })),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageSent: vi.fn(async () => {}),
    runMessageSending: vi.fn(async () => undefined as unknown),
  },
}));
const loggerMocks = vi.hoisted(() => ({
  logger: {
    silly: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));
const queueMocks = vi.hoisted(() => ({
  enqueueDelivery: vi.fn(async () => "mock-queue-id"),
  ackDelivery: vi.fn(async () => {}),
  failDelivery: vi.fn(async () => {}),
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript: mocks.appendAssistantMessageToSessionTranscript,
  };
});
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../logging.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging.js")>("../../logging.js");
  return {
    ...actual,
    getLogger: () => loggerMocks.logger,
  };
});
vi.mock("./delivery-queue.js", () => ({
  enqueueDelivery: queueMocks.enqueueDelivery,
  ackDelivery: queueMocks.ackDelivery,
  failDelivery: queueMocks.failDelivery,
}));

const { deliverOutboundPayloads, normalizeOutboundPayloads } = await import("./deliver.js");

const telegramChunkConfig: OpenClawConfig = {
  channels: { telegram: { botToken: "tok-1", textChunkLimit: 2 } },
};

const whatsappChunkConfig: OpenClawConfig = {
  channels: { whatsapp: { textChunkLimit: 4000 } },
};

async function deliverWhatsAppPayload(params: {
  sendWhatsApp: ReturnType<typeof vi.fn>;
  payload: { text: string; mediaUrl?: string };
  cfg?: OpenClawConfig;
}) {
  return deliverOutboundPayloads({
    cfg: params.cfg ?? whatsappChunkConfig,
    channel: "whatsapp",
    to: "+1555",
    payloads: [params.payload],
    deps: { sendWhatsApp: params.sendWhatsApp },
  });
}

describe("deliverOutboundPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSent.mockReset();
    hookMocks.runner.runMessageSent.mockResolvedValue(undefined);
    queueMocks.enqueueDelivery.mockReset();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.ackDelivery.mockReset();
    queueMocks.ackDelivery.mockResolvedValue(undefined);
    queueMocks.failDelivery.mockReset();
    queueMocks.failDelivery.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });
  it("chunks telegram markdown and passes through accountId", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      const results = await deliverOutboundPayloads({
        cfg: telegramChunkConfig,
        channel: "telegram",
        to: "123",
        payloads: [{ text: "abcd" }],
        deps: { sendTelegram },
      });

      expect(sendTelegram).toHaveBeenCalledTimes(2);
      for (const call of sendTelegram.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ accountId: undefined, verbose: false, textMode: "html" }),
        );
      }
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ channel: "telegram", chatId: "c1" });
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("passes explicit accountId to sendTelegram", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverOutboundPayloads({
      cfg: telegramChunkConfig,
      channel: "telegram",
      to: "123",
      accountId: "default",
      payloads: [{ text: "hi" }],
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({ accountId: "default", verbose: false, textMode: "html" }),
    );
  });

  it("scopes media local roots to the active agent workspace when agentId is provided", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });

    await deliverOutboundPayloads({
      cfg: telegramChunkConfig,
      channel: "telegram",
      to: "123",
      agentId: "work",
      payloads: [{ text: "hi", mediaUrl: "file:///tmp/f.png" }],
      deps: { sendTelegram },
    });

    expect(sendTelegram).toHaveBeenCalledWith(
      "123",
      "hi",
      expect.objectContaining({
        mediaUrl: "file:///tmp/f.png",
        mediaLocalRoots: expect.arrayContaining([path.join(STATE_DIR, "workspace-work")]),
      }),
    );
  });

  it("uses signal media maxBytes from config", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: OpenClawConfig = { channels: { signal: { mediaMaxMb: 2 } } };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "signal",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledWith(
      "+1555",
      "hi",
      expect.objectContaining({
        mediaUrl: "https://x.test/a.jpg",
        maxBytes: 2 * 1024 * 1024,
        textMode: "plain",
        textStyles: [],
      }),
    );
    expect(results[0]).toMatchObject({ channel: "signal", messageId: "s1" });
  });

  it("chunks Signal markdown using the format-first chunker", async () => {
    const sendSignal = vi.fn().mockResolvedValue({ messageId: "s1", timestamp: 123 });
    const cfg: OpenClawConfig = {
      channels: { signal: { textChunkLimit: 20 } },
    };
    const text = `Intro\\n\\n\`\`\`\`md\\n${"y".repeat(60)}\\n\`\`\`\\n\\nOutro`;
    const expectedChunks = markdownToSignalTextChunks(text, 20);

    await deliverOutboundPayloads({
      cfg,
      channel: "signal",
      to: "+1555",
      payloads: [{ text }],
      deps: { sendSignal },
    });

    expect(sendSignal).toHaveBeenCalledTimes(expectedChunks.length);
    expectedChunks.forEach((chunk, index) => {
      expect(sendSignal).toHaveBeenNthCalledWith(
        index + 1,
        "+1555",
        chunk.text,
        expect.objectContaining({
          accountId: undefined,
          textMode: "plain",
          textStyles: chunk.styles,
        }),
      );
    });
  });

  it("chunks WhatsApp text and returns all results", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "w1", toJid: "jid" })
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { textChunkLimit: 2 } },
    };

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "abcd" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(results.map((r) => r.messageId)).toEqual(["w1", "w2"]);
  });

  it("respects newline chunk mode for WhatsApp", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const cfg: OpenClawConfig = {
      channels: { whatsapp: { textChunkLimit: 4000, chunkMode: "newline" } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "Line one\n\nLine two" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "Line one",
      expect.objectContaining({ verbose: false }),
    );
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      2,
      "+1555",
      "Line two",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("strips leading blank lines for WhatsApp text payloads", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: "\n\nHello from WhatsApp" },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "Hello from WhatsApp",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("drops whitespace-only WhatsApp text payloads when no media is attached", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const results = await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: "   \n\t   " },
    });

    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("keeps WhatsApp media payloads but clears whitespace-only captions", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    await deliverWhatsAppPayload({
      sendWhatsApp,
      payload: { text: " \n\t ", mediaUrl: "https://example.com/photo.png" },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp).toHaveBeenNthCalledWith(
      1,
      "+1555",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/photo.png",
        verbose: false,
      }),
    );
  });

  it("preserves fenced blocks for markdown chunkers in newline mode", async () => {
    const chunker = vi.fn((text: string) => (text ? [text] : []));
    const sendText = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    const sendMedia = vi.fn().mockImplementation(async ({ text }: { text: string }) => ({
      channel: "matrix" as const,
      messageId: text,
      roomId: "r1",
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              chunker,
              chunkerMode: "markdown",
              textChunkLimit: 4000,
              sendText,
              sendMedia,
            },
          }),
        },
      ]),
    );

    const cfg: OpenClawConfig = {
      channels: { matrix: { textChunkLimit: 4000, chunkMode: "newline" } },
    };
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";

    await deliverOutboundPayloads({
      cfg,
      channel: "matrix",
      to: "!room",
      payloads: [{ text }],
    });

    expect(chunker).toHaveBeenCalledTimes(1);
    expect(chunker).toHaveBeenNthCalledWith(1, text, 4000);
  });

  it("uses iMessage media maxBytes from agent fallback", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "i1" });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: createIMessageTestPlugin(),
        },
      ]),
    );
    const cfg: OpenClawConfig = {
      agents: { defaults: { mediaMaxMb: 3 } },
    };

    await deliverOutboundPayloads({
      cfg,
      channel: "imessage",
      to: "chat_id:42",
      payloads: [{ text: "hello" }],
      deps: { sendIMessage },
    });

    expect(sendIMessage).toHaveBeenCalledWith(
      "chat_id:42",
      "hello",
      expect.objectContaining({ maxBytes: 3 * 1024 * 1024 }),
    );
  });

  it("normalizes payloads and drops empty entries", () => {
    const normalized = normalizeOutboundPayloads([
      { text: "hi" },
      { text: "MEDIA:https://x.test/a.jpg" },
      { text: " ", mediaUrls: [] },
    ]);
    expect(normalized).toEqual([
      { text: "hi", mediaUrls: [] },
      { text: "", mediaUrls: ["https://x.test/a.jpg"] },
    ]);
  });

  it("continues on errors when bestEffort is enabled", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    const results = await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "a" }, { text: "b" }],
      deps: { sendWhatsApp },
      bestEffort: true,
      onError,
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ channel: "whatsapp", messageId: "w2", toJid: "jid" }]);
  });

  it("calls failDelivery instead of ackDelivery on bestEffort partial failure", async () => {
    const sendWhatsApp = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ messageId: "w2", toJid: "jid" });
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "a" }, { text: "b" }],
      deps: { sendWhatsApp },
      bestEffort: true,
      onError,
    });

    // onError was called for the first payload's failure.
    expect(onError).toHaveBeenCalledTimes(1);

    // Queue entry should NOT be acked — failDelivery should be called instead.
    expect(queueMocks.ackDelivery).not.toHaveBeenCalled();
    expect(queueMocks.failDelivery).toHaveBeenCalledWith(
      "mock-queue-id",
      "partial delivery failure (bestEffort)",
    );
  });

  it("acks the queue entry when delivery is aborted", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const abortController = new AbortController();
    abortController.abort();
    const cfg: OpenClawConfig = {};

    await expect(
      deliverOutboundPayloads({
        cfg,
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "a" }],
        deps: { sendWhatsApp },
        abortSignal: abortController.signal,
      }),
    ).rejects.toThrow("Operation aborted");

    expect(queueMocks.ackDelivery).toHaveBeenCalledWith("mock-queue-id");
    expect(queueMocks.failDelivery).not.toHaveBeenCalled();
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("passes normalized payload to onError", async () => {
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("boom"));
    const onError = vi.fn();
    const cfg: OpenClawConfig = {};

    await deliverOutboundPayloads({
      cfg,
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hi", mediaUrl: "https://x.test/a.jpg" }],
      deps: { sendWhatsApp },
      bestEffort: true,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ text: "hi", mediaUrls: ["https://x.test/a.jpg"] }),
    );
  });

  it("mirrors delivered output when mirror options are provided", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "c1" });
    mocks.appendAssistantMessageToSessionTranscript.mockClear();

    await deliverOutboundPayloads({
      cfg: telegramChunkConfig,
      channel: "telegram",
      to: "123",
      payloads: [{ text: "caption", mediaUrl: "https://example.com/files/report.pdf?sig=1" }],
      deps: { sendTelegram },
      mirror: {
        sessionKey: "agent:main:main",
        text: "caption",
        mediaUrls: ["https://example.com/files/report.pdf?sig=1"],
      },
    });

    expect(mocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ text: "report.pdf" }),
    );
  });

  it("emits message_sent success for text-only deliveries", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "hello" }],
      deps: { sendWhatsApp },
    });

    await vi.waitFor(() => {
      expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({ to: "+1555", content: "hello", success: true }),
        expect.objectContaining({ channelId: "whatsapp" }),
      );
    });
  });

  it("emits message_sent success for sendPayload deliveries", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    const sendPayload = vi.fn().mockResolvedValue({ channel: "matrix", messageId: "mx-1" });
    const sendText = vi.fn();
    const sendMedia = vi.fn();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
          }),
        },
      ]),
    );

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "payload text", channelData: { mode: "custom" } }],
    });

    await vi.waitFor(() => {
      expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({ to: "!room:1", content: "payload text", success: true }),
        expect.objectContaining({ channelId: "matrix" }),
      );
    });
  });

  it("emits message_sent failure when delivery errors", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    const sendWhatsApp = vi.fn().mockRejectedValue(new Error("downstream failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {},
        channel: "whatsapp",
        to: "+1555",
        payloads: [{ text: "hi" }],
        deps: { sendWhatsApp },
      }),
    ).rejects.toThrow("downstream failed");

    await vi.waitFor(() => {
      expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "+1555",
          content: "hi",
          success: false,
          error: "downstream failed",
        }),
        expect.objectContaining({ channelId: "whatsapp" }),
      );
    });
  });
});

// R7 ChannelRenderingPolicy — component→text PHI-aware degradation.
const HEALTH_SUMMARY = "Log salmon meal — 340 cal, 34g protein";
const MINIMIZED_TEXT = "You have a pending action to confirm. Open the app to review and confirm.";

function componentCarrier(opts?: {
  health?: boolean;
  summary?: string;
  pendingId?: string;
  render?: "component" | "navigate" | "url";
}) {
  return {
    type: "component",
    component: {
      type: "component",
      key: "food_log_card",
      props: {},
      ...(opts?.render ? { render: opts.render } : {}),
      ui: {
        summary: opts?.summary ?? HEALTH_SUMMARY,
        ...(opts?.health
          ? { fields: [{ name: "calories", type: "number", value: 340, sensitivity: "health" }] }
          : { fields: [{ name: "note", type: "string", sensitivity: "none" }] }),
        // pending_id requires expires_at (schema refine) — the Governor stamps both.
        ...(opts?.pendingId
          ? { pending_id: opts.pendingId, expires_at: "2030-01-01T00:00:00Z" }
          : {}),
      },
    },
  };
}

/** A malformed component carrier: pending_id without expires_at fails the schema refine. */
function malformedComponentCarrier() {
  return {
    type: "component",
    component: {
      type: "component",
      key: "food_log_card",
      props: {},
      ui: { summary: HEALTH_SUMMARY, pending_id: "cnf_abcdefghijklmnopqrstuvwx" },
    },
  };
}

/** Register a single sendPayload-capable channel plugin and return its spies. */
function registerPayloadChannel(id: string) {
  const sendPayload = vi.fn().mockResolvedValue({ channel: id, messageId: "p1" });
  const sendText = vi.fn().mockResolvedValue({ channel: id, messageId: "t1" });
  const sendMedia = vi.fn().mockResolvedValue({ channel: id, messageId: "m1" });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: id,
        source: "test",
        plugin: createOutboundTestPlugin({
          id,
          outbound: { deliveryMode: "direct", sendPayload, sendText, sendMedia },
        }),
      },
    ]),
  );
  return { sendPayload, sendText, sendMedia };
}

describe("deliverOutboundPayloads — R7 channel rendering policy", () => {
  beforeEach(() => {
    setActivePluginRegistry(defaultRegistry);
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSending.mockReset();
    hookMocks.runner.runMessageSending.mockResolvedValue(undefined);
    hookMocks.runner.runMessageSent.mockReset();
    hookMocks.runner.runMessageSent.mockResolvedValue(undefined);
    loggerMocks.logger.warn.mockReset();
    queueMocks.enqueueDelivery.mockReset();
    queueMocks.enqueueDelivery.mockResolvedValue("mock-queue-id");
    queueMocks.ackDelivery.mockReset();
    queueMocks.failDelivery.mockReset();
  });
  afterEach(() => setActivePluginRegistry(emptyRegistry));

  it("SEC-1: a component-render card with NO health-marked fields but a health ui.summary still MINIMIZES on whatsapp", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    // The producer marks no fields; the macros live in ui.summary. The old
    // per-field gate shipped this to Meta — the channel-keyed gate minimizes.
    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: HEALTH_SUMMARY, channelData: componentCarrier({ render: "component" }) }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const [, sentText] = sendWhatsApp.mock.calls[0];
    expect(sentText).toBe(MINIMIZED_TEXT);
    expect(sentText).not.toContain("salmon");
    expect(sentText).not.toContain("340");
    expect(sentText).not.toContain("protein");
  });

  it("FAIL-CLOSED: a health component on an ARBITRARY UNKNOWN channel MINIMIZES and DROPS channelData", async () => {
    const chan = registerPayloadChannel("some_future_channel");
    const onPayload = vi.fn();

    await deliverOutboundPayloads({
      cfg: {},
      channel: "some_future_channel",
      to: "dest-1",
      payloads: [
        {
          text: HEALTH_SUMMARY,
          channelData: componentCarrier({ health: true, render: "component" }),
        },
      ],
      onPayload,
    });

    // Unknown channel is NOT approved → minimized, channelData dropped (never sent).
    expect(chan.sendPayload).not.toHaveBeenCalled();
    expect(chan.sendText).toHaveBeenCalledTimes(1);
    const sentArg = chan.sendText.mock.calls[0][0];
    expect(sentArg.text).toBe(MINIMIZED_TEXT);
    expect(sentArg.text).not.toContain("340");
    expect(sentArg.text).not.toContain("salmon");
    expect(sentArg.text).not.toContain("protein");
    // onPayload observes the scrubbed summary — channelData carrying the macro is gone.
    expect(onPayload).toHaveBeenCalledWith(
      expect.objectContaining({ text: MINIMIZED_TEXT, channelData: undefined }),
    );
  });

  it("worst case: B4 seeded the health summary as text — B5 SCRUBS it on whatsapp", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: HEALTH_SUMMARY, channelData: componentCarrier({ health: true }) }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const [, sentText] = sendWhatsApp.mock.calls[0];
    expect(sentText).toBe(MINIMIZED_TEXT);
    expect(sentText).not.toContain(HEALTH_SUMMARY);
  });

  it("SEC-2: a MALFORMED component carrier fails safe — whatsapp gets minimized text, not the original", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      // text carries the health summary; the descriptor is unparseable.
      payloads: [{ text: HEALTH_SUMMARY, channelData: malformedComponentCarrier() }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const [, sentText] = sendWhatsApp.mock.calls[0];
    expect(sentText).toBe(MINIMIZED_TEXT);
    expect(sentText).not.toContain(HEALTH_SUMMARY);
  });

  it("SEC-2: a MALFORMED component carrier is NOT forwarded raw via sendPayload", async () => {
    const chan = registerPayloadChannel("matrix");

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: HEALTH_SUMMARY, channelData: malformedComponentCarrier() }],
    });

    // Untrusted component → channelData dropped → sendPayload NOT called; text minimized.
    expect(chan.sendPayload).not.toHaveBeenCalled();
    expect(chan.sendText).toHaveBeenCalledTimes(1);
    expect(chan.sendText.mock.calls[0][0].text).toBe(MINIMIZED_TEXT);
  });

  it("SEC-3: minimizing DROPS co-carried media (meal photo never egresses)", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [
        {
          text: HEALTH_SUMMARY,
          mediaUrl: "https://x.test/meal-photo.jpg",
          channelData: componentCarrier({ health: true }),
        },
      ],
      deps: { sendWhatsApp },
    });

    // Media dropped → single text send, no media arg on any call.
    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp.mock.calls[0][1]).toBe(MINIMIZED_TEXT);
    for (const call of sendWhatsApp.mock.calls) {
      expect(call[2]?.mediaUrl).toBeUndefined();
    }
  });

  it("SEC-5: the message_sending hook + message_sent + onPayload observe MINIMIZED content (not the summary)", async () => {
    hookMocks.runner.hasHooks.mockImplementation(
      (name: string) => name === "message_sending" || name === "message_sent",
    );
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });
    const onPayload = vi.fn();

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: HEALTH_SUMMARY, channelData: componentCarrier({ health: true }) }],
      deps: { sendWhatsApp },
      onPayload,
    });

    // The hook ran AFTER the scrub → observed minimized content, never the summary.
    expect(hookMocks.runner.runMessageSending).toHaveBeenCalledWith(
      expect.objectContaining({ content: MINIMIZED_TEXT }),
      expect.anything(),
    );
    const hookContent = hookMocks.runner.runMessageSending.mock.calls[0][0].content;
    expect(hookContent).not.toContain(HEALTH_SUMMARY);
    expect(onPayload).toHaveBeenCalledWith(expect.objectContaining({ text: MINIMIZED_TEXT }));
    await vi.waitFor(() => {
      expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
        expect.objectContaining({ content: MINIMIZED_TEXT }),
        expect.anything(),
      );
    });
  });

  it("appends a deep-link when configured with a pending_id", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: { gateway: { outboundRendering: { deepLinkBase: "https://app.shrine.test/confirm/" } } },
      channel: "whatsapp",
      to: "+1555",
      payloads: [
        {
          text: HEALTH_SUMMARY,
          channelData: componentCarrier({
            health: true,
            pendingId: "cnf_abcdefghijklmnopqrstuvwx",
          }),
        },
      ],
      deps: { sendWhatsApp },
    });

    const [, sentText] = sendWhatsApp.mock.calls[0];
    expect(sentText).toContain("https://app.shrine.test/confirm/cnf_abcdefghijklmnopqrstuvwx");
    expect(sentText).not.toContain(HEALTH_SUMMARY);
  });

  it("sends full ui.summary on a phiApproved (non-third-party) channel", async () => {
    const chan = registerPayloadChannel("matrix");

    await deliverOutboundPayloads({
      cfg: { gateway: { outboundRendering: { phiApprovedChannels: ["matrix"] } } },
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "narration", channelData: componentCarrier({ health: true }) }],
    });

    // Approved (and not denylisted) → full summary; still degraded to text (dropped carrier).
    expect(chan.sendPayload).not.toHaveBeenCalled();
    expect(chan.sendText).toHaveBeenCalledTimes(1);
    expect(chan.sendText.mock.calls[0][0].text).toBe(HEALTH_SUMMARY);
  });

  it("SEC-4: whatsapp in phiApprovedChannels is IGNORED (denylist wins) → still MINIMIZED", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: { gateway: { outboundRendering: { phiApprovedChannels: ["whatsapp"] } } },
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: HEALTH_SUMMARY, channelData: componentCarrier({ health: true }) }],
      deps: { sendWhatsApp },
    });

    const [, sentText] = sendWhatsApp.mock.calls[0];
    expect(sentText).toBe(MINIMIZED_TEXT);
  });

  it("SEC-4: warns once about an ignored third-party channel in phiApprovedChannels", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    // "discord" is denylisted and used ONLY here → deterministic first-warn.
    await deliverOutboundPayloads({
      cfg: { gateway: { outboundRendering: { phiApprovedChannels: ["discord"] } } },
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: HEALTH_SUMMARY, channelData: componentCarrier({ health: true }) }],
      deps: { sendWhatsApp },
    });

    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining("discord"));
  });

  it("NAV-BYPASS CLOSED: a render:navigate card with a HEALTH summary + media on whatsapp → MINIMIZED, media dropped", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    // The smuggling vector: producer tags a health card render:navigate to reach
    // full-summary. B5 minimizes it regardless of render, and drops the photo.
    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [
        {
          text: HEALTH_SUMMARY,
          mediaUrl: "https://x.test/meal-photo.jpg",
          channelData: componentCarrier({
            render: "navigate",
            health: true,
            summary: HEALTH_SUMMARY,
          }),
        },
      ],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    const [, sentText] = sendWhatsApp.mock.calls[0];
    expect(sentText).toBe(MINIMIZED_TEXT);
    expect(sentText).not.toContain("salmon");
    expect(sentText).not.toContain("340");
    for (const call of sendWhatsApp.mock.calls) {
      expect(call[2]?.mediaUrl).toBeUndefined();
    }
  });

  it("DROPS the carrier so a sendPayload-capable channel receives text, not the component", async () => {
    const chan = registerPayloadChannel("matrix");

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: HEALTH_SUMMARY, channelData: componentCarrier({ health: true }) }],
    });

    expect(chan.sendPayload).not.toHaveBeenCalled();
    expect(chan.sendText).toHaveBeenCalledTimes(1);
    expect(chan.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: MINIMIZED_TEXT }));
  });

  it("leaves a NON-component channelData carrier untouched (behavior-preserving)", async () => {
    const chan = registerPayloadChannel("matrix");

    await deliverOutboundPayloads({
      cfg: {},
      channel: "matrix",
      to: "!room:1",
      payloads: [{ text: "payload text", channelData: { mode: "custom" } }],
    });

    // Non-component envelope is untouched → sendPayload receives it verbatim.
    expect(chan.sendPayload).toHaveBeenCalledTimes(1);
    expect(chan.sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ channelData: { mode: "custom" }, text: "payload text" }),
      }),
    );
    expect(chan.sendText).not.toHaveBeenCalled();
  });

  it("no channelData → byte-identical text delivery (behavior-preserving)", async () => {
    const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "w1", toJid: "jid" });

    await deliverOutboundPayloads({
      cfg: {},
      channel: "whatsapp",
      to: "+1555",
      payloads: [{ text: "plain hello" }],
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).toHaveBeenCalledTimes(1);
    expect(sendWhatsApp.mock.calls[0][1]).toBe("plain hello");
  });
});

const emptyRegistry = createTestRegistry([]);
const defaultRegistry = createTestRegistry([
  {
    pluginId: "telegram",
    plugin: createOutboundTestPlugin({ id: "telegram", outbound: telegramOutbound }),
    source: "test",
  },
  {
    pluginId: "signal",
    plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
    source: "test",
  },
  {
    pluginId: "whatsapp",
    plugin: createOutboundTestPlugin({ id: "whatsapp", outbound: whatsappOutbound }),
    source: "test",
  },
  {
    pluginId: "imessage",
    plugin: createIMessageTestPlugin(),
    source: "test",
  },
]);
