/**
 * P5 (G4) — CANONICAL `memory_*` tool surface.
 *
 * memory-graphiti now registers a backend-stable canonical surface
 * (memory_search / memory_recall / memory_store) so the agent-facing tool names
 * do NOT change when the memory backend swaps (matches memory-core /
 * memory-lancedb's `memory_*` naming). The old plugin-specific names
 * (graphiti_search / graphiti_episodes) remain as DEPRECATED ALIASES for one
 * release — same handler closures, deprecation-prefixed descriptions.
 *
 * Under test:
 *   1. All five tools register (3 canonical + 2 aliases) with the right shapes.
 *   2. memory_search / memory_recall delegate to client.searchFacts /
 *      client.getEpisodes with the resolved groupId when QA-permitted (or
 *      self-hosted), and fail-closed on cloud-without-sender (refuse, no client
 *      call, breach fired).
 *   3. memory_store writes a GraphitiMessage via client.addMessages on
 *      self-hosted, and fail-closed on cloud (no addMessages, breach fired).
 *   4. The canonical tools and their aliases SHARE one implementation — proven
 *      by spying the underlying client method ONCE and exercising BOTH the
 *      canonical and the alias tool: each delegates to the same client call.
 *
 * Harness mirrors tripwire.test.ts's makeFakeApi/registerWith so tool execute
 * functions are captured by name and driven directly.
 */

import { describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const QA_NUMBERS = ["+1000000001", "+1000000002"];
const QA_ONLY_WHATSAPP = { dmPolicy: "allowlist", allowFrom: ["+1000000001"] };
const REAL_WHATSAPP = { dmPolicy: "allowlist", allowFrom: ["+15551234567"] };

type ToolExec = (toolCallId: string, params: unknown) => Promise<unknown> | unknown;

type RegisteredTool = {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute?: ToolExec;
};

function makeFakeApi(opts: {
  pluginConfig: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
}) {
  const tools: Record<string, ToolExec> = {};
  const registered: RegisteredTool[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: {
      channels: opts.whatsapp ? { whatsapp: opts.whatsapp } : {},
    } as Record<string, unknown>,
    pluginConfig: opts.pluginConfig,
    runtime: {} as Record<string, unknown>,
    logger,
    registerTool: vi.fn((tool: unknown) => {
      const t = tool as RegisteredTool;
      registered.push(t);
      if (t?.name && typeof t.execute === "function") {
        tools[t.name] = t.execute;
      }
    }),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => p,
    on: vi.fn(),
  };
  return { api, tools, registered, logger };
}

async function registerWith(opts: {
  pluginConfig: Record<string, unknown>;
  whatsapp?: Record<string, unknown>;
}) {
  const fake = makeFakeApi(opts);
  const mod = await import("./index.js");
  await mod.default.register(fake.api as never);
  return fake;
}

// ============================================================================
// Registration — all five tools register with the right shapes.
// ============================================================================

describe("memory_* tool registration", () => {
  it("registers the 3 canonical tools and the 2 deprecated aliases", async () => {
    const { tools, registered } = await registerWith({
      pluginConfig: { backend: "self-hosted", serverUrl: "http://localhost:8000" },
      whatsapp: REAL_WHATSAPP,
    });

    for (const name of [
      "memory_search",
      "memory_recall",
      "memory_store",
      "graphiti_search",
      "graphiti_episodes",
    ]) {
      expect(typeof tools[name]).toBe("function");
    }

    // exactly these 5 memory/graphiti tools, no more
    const names = registered.map((t) => t.name).filter(Boolean);
    expect(new Set(names)).toEqual(
      new Set([
        "memory_search",
        "memory_recall",
        "memory_store",
        "graphiti_search",
        "graphiti_episodes",
      ]),
    );
  });

  it("prefixes the deprecated aliases' descriptions with a deprecation notice", async () => {
    const { registered } = await registerWith({
      pluginConfig: { backend: "self-hosted", serverUrl: "http://localhost:8000" },
      whatsapp: REAL_WHATSAPP,
    });
    const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

    expect(byName.graphiti_search?.description).toMatch(/^\(deprecated — use memory_search\)/);
    expect(byName.graphiti_episodes?.description).toMatch(/^\(deprecated — use memory_recall\)/);
    // canonical tools are NOT marked deprecated
    expect(byName.memory_search?.description).not.toMatch(/deprecated/i);
    expect(byName.memory_recall?.description).not.toMatch(/deprecated/i);
    expect(byName.memory_store?.description).not.toMatch(/deprecated/i);
  });
});

// ============================================================================
// memory_search — delegation + P3 fail-closed.
// ============================================================================

describe("memory_search", () => {
  it("self-hosted: delegates to client.searchFacts with the resolved groupId", async () => {
    const searchSpy = vi.spyOn(GraphitiRestClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          userId: "u-1",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await tools.memory_search?.("call-1", { query: "coffee", maxFacts: 5 });

      expect(searchSpy).toHaveBeenCalledOnce();
      expect(searchSpy).toHaveBeenCalledWith("coffee", ["u-1"], 5);
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("cloud (no sender ctx): fails closed — no searchFacts, breach logged, refused", async () => {
    const searchSpy = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { tools, logger } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const res = (await tools.memory_search?.("call-1", { query: "anything" })) as {
        details?: { refused?: string };
      };

      expect(searchSpy).not.toHaveBeenCalled();
      expect(res?.details?.refused).toBe("phi_tripwire");
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
    } finally {
      searchSpy.mockRestore();
    }
  });
});

// ============================================================================
// memory_recall — delegation + P3 fail-closed.
// ============================================================================

describe("memory_recall", () => {
  it("self-hosted: delegates to client.getEpisodes with the resolved groupId", async () => {
    const epSpy = vi.spyOn(GraphitiRestClient.prototype, "getEpisodes").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          userId: "u-2",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await tools.memory_recall?.("call-1", { lastN: 7 });

      expect(epSpy).toHaveBeenCalledOnce();
      expect(epSpy).toHaveBeenCalledWith("u-2", 7);
    } finally {
      epSpy.mockRestore();
    }
  });

  it("cloud (no sender ctx): fails closed — no getEpisodes, breach logged, refused", async () => {
    const epSpy = vi.spyOn(ZepCloudClient.prototype, "getEpisodes").mockResolvedValue([]);
    try {
      const { tools, logger } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const res = (await tools.memory_recall?.("call-1", { lastN: 5 })) as {
        details?: { refused?: string };
      };

      expect(epSpy).not.toHaveBeenCalled();
      expect(res?.details?.refused).toBe("phi_tripwire");
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
    } finally {
      epSpy.mockRestore();
    }
  });
});

// ============================================================================
// memory_store — NEW canonical write tool. GraphitiMessage shape + P3.
// ============================================================================

describe("memory_store", () => {
  it("self-hosted: calls client.addMessages with the groupId + GraphitiMessage shape", async () => {
    const addSpy = vi
      .spyOn(GraphitiRestClient.prototype, "addMessages")
      .mockResolvedValue(undefined);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          userId: "u-3",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      const res = (await tools.memory_store?.("call-1", {
        text: "User prefers morning workouts",
      })) as { details?: { stored?: boolean; groupId?: string } };

      expect(addSpy).toHaveBeenCalledOnce();
      const [groupId, messages] = addSpy.mock.calls[0];
      expect(groupId).toBe("u-3");
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "User prefers morning workouts",
        role_type: "user",
        role: "openclaw",
        source_description: "memory_store",
      });
      // timestamp is a valid ISO string
      expect(typeof messages[0].timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(messages[0].timestamp as string))).toBe(false);
      expect(res?.details?.stored).toBe(true);
      expect(res?.details?.groupId).toBe("u-3");
    } finally {
      addSpy.mockRestore();
    }
  });

  it("cloud (no sender ctx): fails closed — no addMessages, breach logged, refused", async () => {
    const addSpy = vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined);
    try {
      const { tools, logger } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const res = (await tools.memory_store?.("call-1", { text: "my BP is 140/90" })) as {
        details?: { stored?: boolean; refused?: string };
      };

      expect(addSpy).not.toHaveBeenCalled();
      expect(res?.details?.stored).toBe(false);
      expect(res?.details?.refused).toBe("phi_tripwire");
      const breachLogged = logger.error.mock.calls.some((c) =>
        String(c[0]).includes("phi_tripwire_breach"),
      );
      expect(breachLogged).toBe(true);
      // breach must NOT carry the stored PHI content
      const leaked = [...logger.error.mock.calls, ...logger.warn.mock.calls].some((c) =>
        String(c[0]).includes("140/90"),
      );
      expect(leaked).toBe(false);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("rejects empty / whitespace text without touching the client", async () => {
    const addSpy = vi
      .spyOn(GraphitiRestClient.prototype, "addMessages")
      .mockResolvedValue(undefined);
    try {
      const { tools } = await registerWith({
        pluginConfig: { backend: "self-hosted", serverUrl: "http://localhost:8000" },
        whatsapp: REAL_WHATSAPP,
      });

      const res = (await tools.memory_store?.("call-1", { text: "   " })) as {
        details?: { stored?: boolean; error?: string };
      };

      expect(addSpy).not.toHaveBeenCalled();
      expect(res?.details?.stored).toBe(false);
      expect(res?.details?.error).toBe("empty_text");
    } finally {
      addSpy.mockRestore();
    }
  });
});

// ============================================================================
// Aliases still work (back-compat) AND share the canonical implementation.
// ============================================================================

describe("graphiti_* deprecated aliases — back-compat + shared impl", () => {
  it("graphiti_search delegates to the SAME client.searchFacts as memory_search", async () => {
    const searchSpy = vi.spyOn(GraphitiRestClient.prototype, "searchFacts").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          userId: "u-9",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await tools.memory_search?.("c1", { query: "q", maxFacts: 3 });
      await tools.graphiti_search?.("c2", { query: "q", maxFacts: 3 });

      // both routed through the one underlying client method, identically
      expect(searchSpy).toHaveBeenCalledTimes(2);
      expect(searchSpy.mock.calls[0]).toEqual(["q", ["u-9"], 3]);
      expect(searchSpy.mock.calls[1]).toEqual(["q", ["u-9"], 3]);
    } finally {
      searchSpy.mockRestore();
    }
  });

  it("graphiti_episodes delegates to the SAME client.getEpisodes as memory_recall", async () => {
    const epSpy = vi.spyOn(GraphitiRestClient.prototype, "getEpisodes").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "self-hosted",
          serverUrl: "http://localhost:8000",
          userId: "u-10",
          groupIdStrategy: "channel-sender",
        },
        whatsapp: REAL_WHATSAPP,
      });

      await tools.memory_recall?.("c1", { lastN: 4 });
      await tools.graphiti_episodes?.("c2", { lastN: 4 });

      expect(epSpy).toHaveBeenCalledTimes(2);
      expect(epSpy.mock.calls[0]).toEqual(["u-10", 4]);
      expect(epSpy.mock.calls[1]).toEqual(["u-10", 4]);
    } finally {
      epSpy.mockRestore();
    }
  });

  it("cloud: graphiti_* aliases still fail-closed (P3 gate unchanged)", async () => {
    const searchSpy = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const epSpy = vi.spyOn(ZepCloudClient.prototype, "getEpisodes").mockResolvedValue([]);
    try {
      const { tools } = await registerWith({
        pluginConfig: {
          backend: "zep-cloud",
          apiKey: "z_key",
          qaNumbers: QA_NUMBERS,
          groupIdStrategy: "channel-sender",
        },
        whatsapp: QA_ONLY_WHATSAPP,
      });

      const r1 = (await tools.graphiti_search?.("c1", { query: "x" })) as {
        details?: { refused?: string };
      };
      const r2 = (await tools.graphiti_episodes?.("c2", { lastN: 3 })) as {
        details?: { refused?: string };
      };

      expect(searchSpy).not.toHaveBeenCalled();
      expect(epSpy).not.toHaveBeenCalled();
      expect(r1?.details?.refused).toBe("phi_tripwire");
      expect(r2?.details?.refused).toBe("phi_tripwire");
    } finally {
      searchSpy.mockRestore();
      epSpy.mockRestore();
    }
  });
});
