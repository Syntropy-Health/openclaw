import type { OpenClawConfig } from "../../../src/config/config.js";
import { SUMMARISER_PROVIDER, type HighlightRunner } from "./generate.js";

type ModelRef = { provider: string; model: string };
type ResolvedModel = { provider: string; id?: string; baseUrl?: string };

/** Hosts the summariser may send facts to. */
export const ANTHROPIC_HOSTS: readonly string[] = Object.freeze(["api.anthropic.com"]);

function isAnthropicHost(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && ANTHROPIC_HOSTS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}
type ContentBlock = { type: string; text?: string };

/**
 * The core functions the adapter uses, injectable for tests. They are the ones
 * TTS summarisation uses (src/tts/tts-core.ts): the gateway's own model
 * resolution and auth, and a single completion with no tools and no agent loop,
 * so no plugin hook fires (A&D D2, as amended for PR-2).
 */
export type RunnerDeps = {
  defaultModelRef: (cfg: OpenClawConfig) => ModelRef;
  resolveModel: (
    provider: string,
    model: string,
    cfg: OpenClawConfig,
  ) => { model?: ResolvedModel; error?: string };
  getApiKey: (model: ResolvedModel, cfg: OpenClawConfig) => Promise<string>;
  complete: (
    model: ResolvedModel,
    context: { messages: Array<{ role: "user"; content: string; timestamp: number }> },
    options: { apiKey: string; signal: AbortSignal; temperature?: number },
  ) => Promise<{ content: ContentBlock[] }>;
};

async function loadCoreDeps(): Promise<RunnerDeps> {
  const [selection, modelMod, auth, piAi] = await Promise.all([
    import("../../../src/agents/model-selection.js"),
    import("../../../src/agents/pi-embedded-runner/model.js"),
    import("../../../src/agents/model-auth.js"),
    import("@mariozechner/pi-ai"),
  ]);
  type CoreModel = Parameters<typeof auth.getApiKeyForModel>[0]["model"];
  return {
    defaultModelRef: (cfg) => selection.resolveDefaultModelForAgent({ cfg }),
    resolveModel: (provider, model, cfg) => modelMod.resolveModel(provider, model, undefined, cfg),
    getApiKey: async (model, cfg) =>
      auth.requireApiKey(
        await auth.getApiKeyForModel({ model: model as CoreModel, cfg }),
        model.provider,
      ),
    complete: (model, context, options) =>
      piAi.completeSimple(model as CoreModel, context, options) as Promise<{
        content: ContentBlock[];
      }>,
  };
}

function parseRef(raw: string): ModelRef {
  const slash = raw.indexOf("/");
  return slash > 0
    ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
    : { provider: "", model: raw };
}

function refuse(what: string): never {
  throw new Error(
    `memory-highlights: summariser must use the ${SUMMARISER_PROVIDER} provider (${what})`,
  );
}

/**
 * The real summariser runner. `model` is "anthropic/<id>" from highlights.model;
 * absent, the agent's default model is used, and only if it is anthropic. The
 * provider is checked on the request, the model ref and the resolved model, each
 * before any network call.
 */
export function createHighlightRunner(params: {
  cfg: OpenClawConfig;
  model?: string;
  deps?: RunnerDeps;
}): HighlightRunner {
  let deps: Promise<RunnerDeps> | undefined = params.deps
    ? Promise.resolve(params.deps)
    : undefined;
  return async (req) => {
    if (req.provider !== SUMMARISER_PROVIDER) {
      refuse("request");
    }
    const d = await (deps ??= loadCoreDeps());
    const ref = params.model ? parseRef(params.model) : d.defaultModelRef(params.cfg);
    if (ref.provider !== SUMMARISER_PROVIDER) {
      refuse("model ref");
    }
    const resolved = d.resolveModel(ref.provider, ref.model, params.cfg);
    if (!resolved.model) {
      throw new Error(resolved.error ?? `Unknown summariser model: ${ref.provider}/${ref.model}`);
    }
    if (resolved.model.provider !== SUMMARISER_PROVIDER) {
      refuse("resolved model");
    }
    // The name is not the destination: a configured baseUrl could send the facts
    // anywhere while the provider name still says anthropic.
    if (resolved.model.baseUrl !== undefined && !isAnthropicHost(resolved.model.baseUrl)) {
      refuse("endpoint host");
    }
    const apiKey = await d.getApiKey(resolved.model, params.cfg);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const res = await d.complete(
        resolved.model,
        { messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }] },
        { apiKey, signal: controller.signal, temperature: 0 },
      );
      const text = res.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) {
        throw new Error("memory-highlights: summariser returned an empty reply");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  };
}
