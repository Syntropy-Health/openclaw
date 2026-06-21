/**
 * Characterization tests for the memory-graphiti extension.
 *
 * These lock the CURRENT behavior of the extension BEFORE the Graphiti-memory
 * refactor (phases P2-P5). They are a behavior-preservation safety net: every
 * test here must PASS against the unchanged production code. They deliberately
 * exercise the four areas later phases will touch:
 *   (a) createClient backend selection
 *   (b) the before_agent_start recall hook (searchFacts + prependContext escaping)
 *   (c) the agent_end capture hook (extractMessages role filtering + addMessages)
 *   (d) resolveIdentityScopeKey external_id -> user_id fallback
 *
 * Pure-function behaviors already covered by index.test.ts / identity.test.ts
 * (extractMessages units, deriveGroupId, formatGraphitiFacts, GraphitiRestClient
 * fetch wiring, deriveChannel/derivePeerId) are NOT duplicated here. This file
 * adds the hook-level wiring and the identity DB resolver, which were untested.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import type { GraphitiConfig } from "./config.js";
import { resolveIdentityScopeKey } from "./identity.js";
import { createClient } from "./index.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

// ============================================================================
// Fakes
// ============================================================================

type CapturedHooks = {
  before_agent_start?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
  agent_end?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
};

/**
 * Minimal OpenClawPluginApi stand-in that captures the lifecycle hooks the
 * plugin registers, so tests can invoke them directly. Only the surface the
 * plugin's register() actually touches is implemented.
 */
function makeFakeApi(pluginConfig: Record<string, unknown>) {
  const hooks: CapturedHooks = {};
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
    config: {} as Record<string, unknown>,
    pluginConfig,
    runtime: {} as Record<string, unknown>,
    logger,
    registerTool: vi.fn(),
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
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      (hooks as Record<string, unknown>)[name] = handler;
    },
  };
  return { api, hooks, logger };
}

/**
 * Register the plugin against the fake api. Imported lazily so the per-test
 * vi.mock of the client modules is in force when index.js resolves them.
 */
async function registerPlugin(pluginConfig: Record<string, unknown>) {
  const { api, hooks, logger } = makeFakeApi(pluginConfig);
  const mod = await import("./index.js");
  await mod.default.register(api as never);
  return { hooks, logger };
}

// ============================================================================
// (a) createClient — backend selection
//
// index.test.ts already covers the three branches at the type level. Here we
// pin the EXACT precedence the factory currently encodes: it is mode+apiKey
// that selects cloud (not apiKey alone), and serverUrl is the fallthrough.
// These are the lines P2 will refactor.
// ============================================================================

describe("characterization: createClient backend precedence", () => {
  const base: Omit<GraphitiConfig, "mode" | "apiKey" | "serverUrl"> = {
    groupIdStrategy: "channel-sender",
    autoCapture: true,
    autoRecall: true,
    maxFacts: 10,
  };

  it("returns ZepCloudClient when mode is cloud AND apiKey is set", () => {
    const client = createClient({ ...base, mode: "cloud", apiKey: "z_key" });
    expect(client).toBeInstanceOf(ZepCloudClient);
    expect(client.label).toBe("zep-cloud");
  });

  it("returns GraphitiRestClient when serverUrl is set and apiKey is absent", () => {
    const client = createClient({
      ...base,
      mode: "self-hosted",
      serverUrl: "http://localhost:8000",
    });
    expect(client).toBeInstanceOf(GraphitiRestClient);
    expect(client.label).toContain("graphiti-rest");
  });

  it("falls through to GraphitiRestClient when mode is cloud but apiKey is missing (serverUrl present)", () => {
    // The cloud branch requires BOTH mode==='cloud' AND apiKey; mode alone is
    // not enough. This surprising-but-current behavior is what later phases
    // must preserve or deliberately change.
    const client = createClient({
      ...base,
      mode: "cloud",
      serverUrl: "http://localhost:8000",
    });
    expect(client).toBeInstanceOf(GraphitiRestClient);
  });

  it("throws when neither apiKey nor serverUrl is configured", () => {
    expect(() => createClient({ ...base, mode: "self-hosted" })).toThrow("no backend configured");
  });
});

// ============================================================================
// (b) RECALL — before_agent_start hook
// (c) CAPTURE — agent_end hook
//
// Drive the real plugin.register() against a fake api. The plugin selects the
// self-hosted GraphitiRestClient (serverUrl, no apiKey); we stub its prototype
// methods (the only true external edge — network) via vi.spyOn, so the real
// createClient + real client instance run, but no fetch fires. This keeps
// section (a) using the genuine, unmocked constructors.
// ============================================================================

const searchFactsSpy = vi.spyOn(GraphitiRestClient.prototype, "searchFacts");
const addMessagesSpy = vi.spyOn(GraphitiRestClient.prototype, "addMessages");

describe("characterization: before_agent_start recall hook", () => {
  beforeEach(() => {
    searchFactsSpy.mockReset().mockResolvedValue([]);
    addMessagesSpy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls searchFacts(prompt, [groupId], maxFacts) and injects escaped facts via prependContext", async () => {
    searchFactsSpy.mockResolvedValueOnce([
      {
        uuid: "u1",
        name: "pref",
        fact: 'User said <b>"hi"</b> & smiled',
        valid_at: "2026-01-15T10:00:00Z",
        invalid_at: null,
        created_at: "2026-01-15T10:00:00Z",
        expired_at: null,
      },
    ]);

    const { hooks } = await registerPlugin({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
      maxFacts: 7,
    });

    const ctx = {
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:direct:7550356539",
    };
    const result = (await hooks.before_agent_start?.(
      { prompt: "what do you know about me?" },
      ctx,
    )) as { prependContext?: string } | undefined;

    // searchFacts called with prompt, derived groupId in an array, and maxFacts
    expect(searchFactsSpy).toHaveBeenCalledOnce();
    const [query, groupIds, maxFacts] = searchFactsSpy.mock.calls[0];
    expect(query).toBe("what do you know about me?");
    expect(groupIds).toEqual(["telegram:7550356539"]);
    expect(maxFacts).toBe(7);

    // facts injected via prependContext, HTML-escaped, wrapped, with date suffix
    expect(result?.prependContext).toContain("<graphiti-facts>");
    expect(result?.prependContext).toContain("&lt;b&gt;&quot;hi&quot;&lt;/b&gt; &amp; smiled");
    expect(result?.prependContext).not.toContain('<b>"hi"</b>');
    expect(result?.prependContext).toContain("(since: 2026-01-15)");
  });

  it("returns undefined (no injection) when searchFacts yields no facts", async () => {
    searchFactsSpy.mockResolvedValueOnce([]);
    const { hooks } = await registerPlugin({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
    });
    const result = await hooks.before_agent_start?.(
      { prompt: "anything relevant?" },
      { sessionKey: "agent:main:cli:main" },
    );
    expect(result).toBeUndefined();
    expect(searchFactsSpy).toHaveBeenCalledOnce();
  });

  it("skips recall entirely for prompts shorter than 5 chars (searchFacts not called)", async () => {
    const { hooks } = await registerPlugin({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
    });
    const result = await hooks.before_agent_start?.({ prompt: "hi" }, {});
    expect(result).toBeUndefined();
    expect(searchFactsSpy).not.toHaveBeenCalled();
  });
});

describe("characterization: agent_end capture hook", () => {
  beforeEach(() => {
    searchFactsSpy.mockReset().mockResolvedValue([]);
    addMessagesSpy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("captures ONLY user+assistant messages, excluding tool/system and empty content", async () => {
    const { hooks } = await registerPlugin({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
    });

    await hooks.agent_end?.(
      {
        success: true,
        messages: [
          { role: "system", content: "you are a bot" },
          { role: "user", content: "Hello" },
          { role: "tool", content: "tool output" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "   " },
        ],
      },
      {
        messageProvider: "telegram",
        sessionKey: "agent:main:telegram:direct:7550356539",
      },
    );

    expect(addMessagesSpy).toHaveBeenCalledOnce();
    const [groupId, captured] = addMessagesSpy.mock.calls[0] as [
      string,
      Array<{ content: string; role_type: string; role: string }>,
    ];

    expect(groupId).toBe("telegram:7550356539");
    // system, tool, and whitespace-only user are excluded
    expect(captured).toHaveLength(2);
    expect(captured.map((m) => m.content)).toEqual(["Hello", "Hi!"]);
    expect(captured.map((m) => m.role_type)).toEqual(["user", "assistant"]);
    // role mapping: assistant -> "openclaw"; user -> messageProvider
    expect(captured[0].role).toBe("telegram");
    expect(captured[1].role).toBe("openclaw");
  });

  it("does not call addMessages when the run was unsuccessful", async () => {
    const { hooks } = await registerPlugin({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
    });
    await hooks.agent_end?.(
      { success: false, messages: [{ role: "user", content: "Hello" }] },
      { sessionKey: "agent:main:cli:main" },
    );
    expect(addMessagesSpy).not.toHaveBeenCalled();
  });

  it("does not call addMessages when no user/assistant messages survive extraction", async () => {
    const { hooks } = await registerPlugin({
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
    });
    await hooks.agent_end?.(
      { success: true, messages: [{ role: "tool", content: "only tool output" }] },
      { sessionKey: "agent:main:cli:main" },
    );
    expect(addMessagesSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// (d) IDENTITY — resolveIdentityScopeKey external_id -> user_id fallback
//
// Exercise the real exported resolver against a fake `sql` tagged-template
// (the only true external edge — the DB). No vi.mock needed.
// ============================================================================

describe("characterization: resolveIdentityScopeKey", () => {
  function fakeSql(rows: Array<Record<string, unknown>>) {
    // postgres' Sql is callable as a tagged template; resolveIdentityScopeKey
    // only awaits the returned promise and reads rows[0].
    const fn = (() => Promise.resolve(rows)) as unknown as import("postgres").Sql;
    return fn;
  }

  it("returns external_id when present (cross-channel canonical key)", async () => {
    const sql = fakeSql([{ id: "uuid-1", external_id: "auth0|abc123" }]);
    const key = await resolveIdentityScopeKey(sql, {
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:direct:7550356539",
    });
    expect(key).toBe("auth0|abc123");
  });

  it("falls back to the internal user_id UUID when external_id is null", async () => {
    const sql = fakeSql([{ id: "uuid-2", external_id: null }]);
    const key = await resolveIdentityScopeKey(sql, {
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:direct:7550356539",
    });
    expect(key).toBe("uuid-2");
  });

  it("returns null when no matching identity row exists", async () => {
    const sql = fakeSql([]);
    const key = await resolveIdentityScopeKey(sql, {
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:direct:7550356539",
    });
    expect(key).toBeNull();
  });

  it("returns null without querying for unresolvable peers (main / unknown)", async () => {
    const queried = vi.fn(() => Promise.resolve([]));
    const sql = queried as unknown as import("postgres").Sql;
    const key = await resolveIdentityScopeKey(sql, {
      sessionKey: "agent:main:main",
    });
    expect(key).toBeNull();
    expect(queried).not.toHaveBeenCalled();
  });
});
