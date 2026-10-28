import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));
vi.mock("../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));

import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { runCliAgent } from "../agents/cli-runner.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { ImageInputUnsupportedError } from "../agents/pi-embedded-runner/run/images.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { emitAgentEvent, onAgentEvent } from "../infra/agent-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { agentCommand } from "./agent.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  telegramOverrides?: Partial<NonNullable<OpenClawConfig["telegram"]>>,
  agentsList?: Array<{ id: string; default?: boolean }>,
) {
  configSpy.mockReturnValue({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-5" },
        models: { "anthropic/claude-opus-4-5": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
      list: agentsList,
    },
    session: { store: storePath, mainKey: "main" },
    telegram: telegramOverrides ? { ...telegramOverrides } : undefined,
  });
}

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
});

describe("agentCommand", () => {
  it("creates a session entry when deriving from --to", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hello", to: "+1555" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.sessionId).toBeTruthy();
    });
  });

  it("persists thinking and verbose overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1222", thinking: "high", verbose: "on" }, runtime);

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { thinkingLevel?: string; verboseLevel?: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.verboseLevel).toBe("on");

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("high");
      expect(callArgs?.verboseLevel).toBe("on");
    });
  });

  it("resumes when session-id is provided", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        foo: {
          sessionId: "session-123",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });
      mockConfig(home, store);

      await agentCommand({ message: "resume me", sessionId: "session-123" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionId).toBe("session-123");
    });
  });

  it("does not duplicate agent events from embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      const assistantEvents: Array<{ runId: string; text?: string }> = [];
      const stop = onAgentEvent((evt) => {
        if (evt.stream !== "assistant") {
          return;
        }
        assistantEvents.push({
          runId: evt.runId,
          text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
        });
      });

      vi.mocked(runEmbeddedPiAgent).mockImplementationOnce(async (params) => {
        const runId = (params as { runId?: string } | undefined)?.runId ?? "run";
        const data = { text: "hello", delta: "hello" };
        (
          params as {
            onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
          }
        ).onAgentEvent?.({ stream: "assistant", data });
        emitAgentEvent({ runId, stream: "assistant", data });
        return {
          payloads: [{ text: "hello" }],
          meta: { agentMeta: { provider: "p", model: "m" } },
        } as never;
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);
      stop();

      const matching = assistantEvents.filter((evt) => evt.text === "hello");
      expect(matching).toHaveLength(1);
    });
  });

  it("uses provider/model from agents.defaults.model.primary", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
        },
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-4.1-mini");
    });
  });

  it("uses default fallback list for session model overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:test": {
          sessionId: "session-subagent",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-5",
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.2"],
        },
        models: {
          "anthropic/claude-opus-4-5": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.2": {},
        },
      });

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-opus-4-5", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedPiAgent)
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
        .mockResolvedValueOnce({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "session-subagent", provider: "openai", model: "gpt-5.2" },
          },
        });

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:test",
        },
        runtime,
      );

      const attempts = vi
        .mocked(runEmbeddedPiAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([
        { provider: "anthropic", model: "claude-opus-4-5" },
        { provider: "openai", model: "gpt-5.2" },
      ]);
    });
  });

  it("passes caller images to the fallback retry, not only the first attempt", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: {
          primary: "anthropic/claude-haiku-4-5",
          fallbacks: ["openai/gpt-5.2"],
        },
        models: {
          "anthropic/claude-haiku-4-5": {},
          "openai/gpt-5.2": {},
        },
      });
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-haiku-4-5", name: "Haiku", provider: "anthropic" },
        { id: "gpt-5.2", name: "GPT-5.2", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedPiAgent)
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
        .mockResolvedValueOnce({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "openai", model: "gpt-5.2" },
          },
        });
      const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/jpeg" }];

      await agentCommand({ message: "what did I eat?", to: "+1555", images }, runtime);

      const calls = vi.mocked(runEmbeddedPiAgent).mock.calls.map((call) => call[0]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.images).toEqual(images);
      expect(calls[1]?.provider).toBe("openai");
      expect(calls[1]?.images).toEqual(images);
    });
  });

  describe("image-capable fallback filter", () => {
    const IMAGES = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/jpeg" }];
    const BODY = "what did I eat?";
    const inlineModel = (id: string, input: Array<"text" | "image">) => ({
      id,
      name: id,
      reasoning: false,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    });

    /** A config whose acme/* models declare their input capability inline. */
    function mockImageConfig(home: string, primary: string, fallbacks: string[]) {
      const store = path.join(home, "sessions.json");
      const refs = [primary, ...fallbacks];
      configSpy.mockReturnValue({
        agents: {
          defaults: {
            model: { primary, fallbacks },
            models: Object.fromEntries(refs.map((ref) => [ref, {}])),
            workspace: path.join(home, "openclaw"),
          },
        },
        models: {
          providers: {
            acme: {
              baseUrl: "http://127.0.0.1:9/v1",
              api: "openai-completions",
              models: [
                inlineModel("text-only", ["text"]),
                inlineModel("text-only-2", ["text"]),
                inlineModel("vision", ["text", "image"]),
                inlineModel("vision-2", ["text", "image"]),
              ],
            },
          },
        },
        session: { store, mainKey: "main" },
      } as never);
    }

    const ok = (model: string) => ({
      payloads: [{ text: "oatmeal" }],
      meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "acme", model } },
    });
    const embeddedCalls = () => vi.mocked(runEmbeddedPiAgent).mock.calls.map((call) => call[0]);

    it("never starts a text-only primary; the vision fallback runs first with the user's prompt", async () => {
      await withTempHome(async (home) => {
        mockImageConfig(home, "acme/text-only", ["acme/vision"]);
        vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce(ok("vision"));

        await agentCommand({ message: BODY, to: "+1555", images: IMAGES }, runtime);

        const calls = embeddedCalls();
        expect(calls.map((c) => c?.model)).toEqual(["vision"]);
        expect(calls[0]?.prompt).toBe(BODY);
        expect(calls[0]?.images).toEqual(IMAGES);
      });
    });

    it("a vision model missing from the provider's inline list is KEPT (capability unknown)", async () => {
      await withTempHome(async (home) => {
        // acme is configured but does not list this model: resolveModel synthesises a
        // generic text-only entry for it. That is not evidence of text-only: keep it.
        mockImageConfig(home, "acme/vision-unlisted", []);
        vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce(ok("vision-unlisted"));

        await agentCommand({ message: BODY, to: "+1555", images: IMAGES }, runtime);

        const calls = embeddedCalls();
        expect(calls.map((c) => c?.model)).toEqual(["vision-unlisted"]);
        expect(calls[0]?.images).toEqual(IMAGES);
      });
    });

    it('a model listed with input ["text"] is filtered (known text-only)', async () => {
      await withTempHome(async (home) => {
        mockImageConfig(home, "acme/text-only", ["acme/vision-unlisted"]);
        vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce(ok("vision-unlisted"));

        await agentCommand({ message: BODY, to: "+1555", images: IMAGES }, runtime);

        expect(embeddedCalls().map((c) => c?.model)).toEqual(["vision-unlisted"]);
      });
    });

    it("all candidates text-only: ImageInputUnsupportedError with 0 runner calls", async () => {
      await withTempHome(async (home) => {
        mockImageConfig(home, "acme/text-only", ["acme/text-only-2"]);

        await expect(
          agentCommand({ message: BODY, to: "+1555", images: IMAGES }, runtime),
        ).rejects.toBeInstanceOf(ImageInputUnsupportedError);
        expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
      });
    });

    it("without images the text-only models run as before (no filtering)", async () => {
      await withTempHome(async (home) => {
        mockImageConfig(home, "acme/text-only", ["acme/vision"]);
        vi.mocked(runEmbeddedPiAgent).mockResolvedValueOnce(ok("text-only"));

        await agentCommand({ message: BODY, to: "+1555" }, runtime);

        expect(embeddedCalls().map((c) => c?.model)).toEqual(["text-only"]);
      });
    });

    it("vision 429 -> vision fallback: base continuation prompt, plus the images", async () => {
      await withTempHome(async (home) => {
        mockImageConfig(home, "acme/vision", ["acme/vision-2"]);
        vi.mocked(runEmbeddedPiAgent)
          .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
          .mockResolvedValueOnce(ok("vision-2"));

        await agentCommand({ message: BODY, to: "+1555", images: IMAGES }, runtime);

        const calls = embeddedCalls();
        expect(calls.map((c) => c?.prompt)).toEqual([
          BODY,
          "Continue where you left off. The previous model attempt failed or timed out.",
        ]);
        expect(calls[1]?.images).toEqual(IMAGES);
      });
    });

    it("vision 429 with only a text-only fallback: the real 429 failure, never the image 400", async () => {
      await withTempHome(async (home) => {
        mockImageConfig(home, "acme/vision", ["acme/text-only"]);
        vi.mocked(runEmbeddedPiAgent).mockRejectedValueOnce(
          Object.assign(new Error("rate limited"), { status: 429 }),
        );

        const err = await agentCommand(
          { message: BODY, to: "+1555", images: IMAGES },
          runtime,
        ).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(embeddedCalls().map((c) => c?.model)).toEqual(["vision"]);
        expect(err).toBeDefined();
        expect(err).not.toBeInstanceOf(ImageInputUnsupportedError);
        expect((err as { status?: number }).status).toBe(429);
      });
    });

    it("per-candidate timeout: the fallback gets the continuation; the body is sent exactly once", async () => {
      await withTempHome(async (home) => {
        vi.stubEnv("OPENCLAW_MODEL_CANDIDATE_TIMEOUT_MS", "50");
        mockImageConfig(home, "acme/vision", ["acme/vision-2"]);
        vi.mocked(runEmbeddedPiAgent)
          .mockImplementationOnce(() => new Promise(() => {})) // a hung primary
          .mockResolvedValueOnce(ok("vision-2"));

        await agentCommand({ message: BODY, to: "+1555", images: IMAGES }, runtime);

        const calls = embeddedCalls();
        expect(calls.map((c) => c?.model)).toEqual(["vision", "vision-2"]);
        expect(calls[1]?.prompt).toMatch(/^Continue where you left off/);
        // No duplicate user message: the user's own text went into the transcript once.
        expect(calls.filter((c) => c?.prompt === BODY)).toHaveLength(1);
      });
    });
  });

  it("CLI backends: a fallback retry omits images (base behaviour, known limitation)", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "claude-cli/opus", fallbacks: ["codex-cli/gpt-5"] },
        models: { "claude-cli/opus": {}, "codex-cli/gpt-5": {} },
      });
      vi.mocked(runCliAgent)
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
        .mockResolvedValueOnce({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "s", provider: "codex-cli", model: "gpt-5" },
          },
        });
      const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/jpeg" }];

      await agentCommand({ message: "what did I eat?", to: "+1555", images }, runtime);

      const calls = vi.mocked(runCliAgent).mock.calls.map((call) => call[0]);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.images).toEqual(images);
      expect(calls[0]?.prompt).toBe("what did I eat?");
      expect(calls[1]?.images).toBeUndefined();
      expect(calls[1]?.prompt).toMatch(/^Continue where you left off/);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("keeps explicit sessionKey even when sessionId exists elsewhere", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          sessionId: "sess-main",
          sessionKey: "agent:main:subagent:abc",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:main:subagent:abc");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(saved["agent:main:subagent:abc"]?.sessionId).toBe("sess-main");
    });
  });

  it("derives session key from --agent when no routing target is provided", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:ops:main");
      expect(callArgs?.sessionFile).toContain(`${path.sep}agents${path.sep}ops${path.sep}sessions`);
    });
  });

  it("rejects unknown agent overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await expect(agentCommand({ message: "hi", agentId: "ghost" }, runtime)).rejects.toThrow(
        'Unknown agent id "ghost"',
      );
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });

  it("prints JSON payload when requested", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
        meta: {
          durationMs: 42,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1999", json: true }, runtime);

      const logged = (runtime.log as MockInstance).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(logged) as {
        payloads: Array<{ text: string; mediaUrl?: string | null }>;
        meta: { durationMs: number };
      };
      expect(parsed.payloads[0].text).toBe("json-reply");
      expect(parsed.payloads[0].mediaUrl).toBe("http://x.test/a.jpg");
      expect(parsed.meta.durationMs).toBe(42);
    });
  });

  it("passes the message through as the agent prompt", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "ping", to: "+1333" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.prompt).toBe("ping");
    });
  });

  it("passes through telegram accountId when delivering", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, { botToken: "t-1" });
      setTelegramRuntime(createPluginRuntime());
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      );
      const deps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "123" }),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "";
      try {
        await agentCommand(
          {
            message: "hi",
            to: "123",
            deliver: true,
            channel: "telegram",
          },
          runtime,
          deps,
        );

        expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
          "123",
          "ok",
          expect.objectContaining({ accountId: undefined, verbose: false }),
        );
      } finally {
        if (prevTelegramToken === undefined) {
          delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
          process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
        }
      }
    });
  });

  it("uses reply channel as the message channel context", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops", replyChannel: "slack" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.messageChannel).toBe("slack");
    });
  });

  it("prefers runContext for embedded routing", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          to: "+1555",
          channel: "whatsapp",
          runContext: { messageChannel: "slack", accountId: "acct-2" },
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.messageChannel).toBe("slack");
      expect(callArgs?.agentAccountId).toBe("acct-2");
    });
  });

  it("forwards accountId to embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1555", accountId: "kev" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.agentAccountId).toBe("kev");
    });
  });

  it("logs output when delivery is disabled", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand({ message: "hi", agentId: "ops" }, runtime);

      expect(runtime.log).toHaveBeenCalledWith("ok");
    });
  });
});
