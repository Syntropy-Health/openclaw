/**
 * The summariser adapter (PLAN P4.3, D2 as amended): one completeSimple call
 * through the gateway's own model resolution and auth. No agent run, so no plugin
 * hook fires. The core functions are injected, so no test reaches a provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUMMARISER_TIMEOUT_MS } from "./generate.js";
import { createHighlightRunner, type RunnerDeps } from "./runner.js";

const CFG = { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-5" } } } };
const REQ = { provider: "anthropic" as const, prompt: "PROMPT", timeoutMs: SUMMARISER_TIMEOUT_MS };

function deps(over: Partial<RunnerDeps> = {}) {
  const d: RunnerDeps = {
    defaultModelRef: vi.fn(() => ({ provider: "anthropic", model: "claude-sonnet-4-5" })),
    resolveModel: vi.fn((provider: string, model: string) => ({
      model: { provider, id: model },
    })),
    getApiKey: vi.fn(async () => "k"),
    complete: vi.fn(async () => ({
      content: [
        { type: "text", text: '{"highlights":' },
        { type: "thinking", thinking: "x" },
        { type: "text", text: "[]}" },
      ],
    })),
    ...over,
  };
  return d;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createHighlightRunner", () => {
  it("defaults to the agent's model when it is anthropic, and returns the joined text", async () => {
    const d = deps();
    const run = createHighlightRunner({ cfg: CFG, deps: d });
    expect(await run(REQ)).toBe('{"highlights":\n[]}');
    expect(d.resolveModel).toHaveBeenCalledWith("anthropic", "claude-sonnet-4-5", CFG);
    const [model, ctx, options] = vi.mocked(d.complete).mock.calls[0];
    expect(model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
    expect(ctx.messages).toEqual([expect.objectContaining({ role: "user", content: "PROMPT" })]);
    expect((ctx as { tools?: unknown }).tools).toBeUndefined();
    expect(options).toMatchObject({ apiKey: "k" });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("a configured anthropic model overrides the default", async () => {
    const d = deps();
    await createHighlightRunner({ cfg: CFG, model: "anthropic/claude-haiku-4-5", deps: d })(REQ);
    expect(d.resolveModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5", CFG);
    expect(d.defaultModelRef).not.toHaveBeenCalled();
  });

  it("a non-anthropic default model is refused before resolution, auth or any call", async () => {
    const d = deps({ defaultModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5" })) });
    await expect(createHighlightRunner({ cfg: CFG, deps: d })(REQ)).rejects.toThrow(/anthropic/);
    expect(d.resolveModel).not.toHaveBeenCalled();
    expect(d.getApiKey).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("a non-anthropic configured model or request is refused with no call", async () => {
    const d = deps();
    await expect(
      createHighlightRunner({ cfg: CFG, model: "openai/gpt-5", deps: d })(REQ),
    ).rejects.toThrow(/anthropic/);
    await expect(
      createHighlightRunner({ cfg: CFG, deps: d })({
        ...REQ,
        provider: "openai" as unknown as "anthropic",
      }),
    ).rejects.toThrow(/anthropic/);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("a resolved model on another provider (an alias) is refused with no call", async () => {
    const d = deps({ resolveModel: vi.fn(() => ({ model: { provider: "openrouter", id: "x" } })) });
    await expect(createHighlightRunner({ cfg: CFG, deps: d })(REQ)).rejects.toThrow(/anthropic/);
    expect(d.getApiKey).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("an unknown model or missing key fails without a call", async () => {
    const unknown = deps({ resolveModel: vi.fn(() => ({ error: "Unknown model" })) });
    await expect(createHighlightRunner({ cfg: CFG, deps: unknown })(REQ)).rejects.toThrow(
      /Unknown model/,
    );
    expect(unknown.complete).not.toHaveBeenCalled();
    const nokey = deps({
      getApiKey: vi.fn(async () => {
        throw new Error("No API key");
      }),
    });
    await expect(createHighlightRunner({ cfg: CFG, deps: nokey })(REQ)).rejects.toThrow(/API key/);
    expect(nokey.complete).not.toHaveBeenCalled();
  });

  it("aborts the call at the timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const d = deps({
      complete: vi.fn<RunnerDeps["complete"]>(
        (_m, _c, o) =>
          new Promise((_, reject) => {
            signal = o.signal;
            o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    });
    const p = createHighlightRunner({ cfg: CFG, deps: d })({ ...REQ, timeoutMs: 1000 });
    const settled = expect(p).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(signal?.aborted).toBe(true);
  });

  it("an empty reply is an error, not an empty string", async () => {
    const d = deps({ complete: vi.fn(async () => ({ content: [{ type: "text", text: "  " }] })) });
    await expect(createHighlightRunner({ cfg: CFG, deps: d })(REQ)).rejects.toThrow(/empty/);
  });
});

describe("createHighlightRunner endpoint pin (QG)", () => {
  it("a resolved anthropic model with a non-Anthropic baseUrl is refused before auth or any call", async () => {
    for (const baseUrl of ["https://evil.example.com", "http://api.anthropic.com", "not a url"]) {
      const d = deps({
        resolveModel: vi.fn(() => ({ model: { provider: "anthropic", id: "m", baseUrl } })),
      });
      await expect(createHighlightRunner({ cfg: CFG, deps: d })(REQ)).rejects.toThrow(/anthropic/);
      expect(d.getApiKey).not.toHaveBeenCalled();
      expect(d.complete).not.toHaveBeenCalled();
    }
  });

  it("the Anthropic API host is accepted", async () => {
    const d = deps({
      resolveModel: vi.fn(() => ({
        model: { provider: "anthropic", id: "m", baseUrl: "https://api.anthropic.com" },
      })),
    });
    await expect(createHighlightRunner({ cfg: CFG, deps: d })(REQ)).resolves.toContain(
      "highlights",
    );
  });
});
