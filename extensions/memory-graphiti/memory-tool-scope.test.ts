/**
 * Memory tools are scoped to the session that calls them.
 *
 * The tools are registered through a factory that receives the calling session
 * (`OpenClawPluginToolContext.sessionKey`). The hooks record each session's
 * resolved memory group; a tool call uses its own session's group, and refuses
 * when its session has no recorded group.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import { externalIdScopeKey } from "./identity.js";
import { opaqueGroupId } from "./receipts.js";

type ToolExec = (toolCallId: string, params: unknown) => Promise<unknown> | unknown;
type Tool = { name?: string; execute?: ToolExec };
type ToolCtx = { sessionKey?: string; messageChannel?: string };
type Hook = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeFakeApi(
  pluginConfig: Record<string, unknown>,
  hostConfig: Record<string, unknown> = {},
) {
  const registrations: unknown[] = [];
  const hooks: Record<string, Hook[]> = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: { channels: {}, ...hostConfig } as Record<string, unknown>,
    pluginConfig,
    runtime: {} as Record<string, unknown>,
    logger,
    registerTool: vi.fn((tool: unknown) => registrations.push(tool)),
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
    on: vi.fn((event: string, handler: Hook) => {
      (hooks[event] ??= []).push(handler);
    }),
  };
  // Resolve a tool the way the host does: a factory gets the calling session.
  const toolFor = (name: string, ctx: ToolCtx): ToolExec | undefined => {
    for (const reg of registrations) {
      const out = typeof reg === "function" ? (reg as (c: ToolCtx) => unknown)(ctx) : reg;
      for (const t of (Array.isArray(out) ? out : [out]) as Tool[]) {
        if (t?.name === name && typeof t.execute === "function") {
          return t.execute;
        }
      }
    }
    return undefined;
  };
  return { api, hooks, toolFor };
}

async function setup(
  overrides: Record<string, unknown> = {},
  hostConfig: Record<string, unknown> = {},
) {
  const fake = makeFakeApi(
    {
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "channel-sender",
      autoCapture: true,
      autoRecall: false,
      ...overrides,
    },
    hostConfig,
  );
  const mod = await import("./index.js");
  await mod.default.register(fake.api as never);
  return fake;
}

const SESSION_A = "agent:main:telegram:direct:alice";
const SESSION_B = "agent:main:telegram:direct:bob";
const turn = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

let searchSpy: ReturnType<typeof vi.spyOn>;
let episodesSpy: ReturnType<typeof vi.spyOn>;
let addSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv("OPENCLAW_MEMORY_GROUP_KEY", "");
  // No network: every backend call is stubbed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    }),
  );
  searchSpy = vi.spyOn(GraphitiRestClient.prototype, "searchFacts").mockResolvedValue([]);
  episodesSpy = vi.spyOn(GraphitiRestClient.prototype, "getEpisodes").mockResolvedValue([]);
  addSpy = vi.spyOn(GraphitiRestClient.prototype, "addMessages").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function startFor(hooks: Record<string, Hook[]>, sessionKey: string) {
  for (const h of hooks.before_agent_start ?? []) {
    await h({ prompt: "hello there" }, { sessionKey, messageProvider: "telegram" });
  }
}

async function captureFor(hooks: Record<string, Hook[]>, sessionKey: string) {
  for (const h of hooks.agent_end ?? []) {
    await h({ success: true, messages: turn }, { sessionKey, messageProvider: "telegram" });
  }
}

describe("memory tools: per-session scope", () => {
  it("uses the calling session's group", async () => {
    const { hooks, toolFor } = await setup();
    const searchAs = async (sessionKey: string) => {
      await toolFor("memory_search", { sessionKey, messageChannel: "telegram" })?.("c", {
        query: "q",
      });
      return searchSpy.mock.calls.at(-1)?.[1] as unknown[];
    };
    await startFor(hooks, SESSION_A);
    await startFor(hooks, SESSION_B); // B's turn starts after A's
    const aWhileBLast = await searchAs(SESSION_A);
    await startFor(hooks, SESSION_A); // then A's again
    const aWhileALast = await searchAs(SESSION_A);
    const bWhileALast = await searchAs(SESSION_B);
    expect(searchSpy).toHaveBeenCalledTimes(3);
    expect(aWhileBLast).toEqual(aWhileALast);
    expect(bWhileALast).not.toEqual(aWhileALast);
  });

  it("a late agent_end from an earlier turn does not change the running turn's group", async () => {
    const { hooks, toolFor } = await setup();
    const startTurn = async (messageProvider: string) => {
      for (const h of hooks.before_agent_start ?? []) {
        await h({ prompt: "hello there" }, { sessionKey: SESSION_A, messageProvider });
      }
    };
    const searchAsA = async () => {
      await toolFor("memory_search", { sessionKey: SESSION_A, messageChannel: "telegram" })?.("c", {
        query: "q",
      });
      return searchSpy.mock.calls.at(-1)?.[1] as unknown[];
    };
    await startTurn("telegram"); // turn N+1 starts and records its group
    const running = await searchAsA();
    // Turn N's capture (fire-and-forget) lands late, with a different resolved group.
    for (const h of hooks.agent_end ?? []) {
      await h(
        { success: true, messages: turn },
        { sessionKey: SESSION_A, messageProvider: "slack" },
      );
    }
    expect(await searchAsA()).toEqual(running);
  });

  it("refuses when the calling session has no recorded group", async () => {
    const { hooks, toolFor } = await setup();
    await captureFor(hooks, SESSION_A);
    await toolFor("memory_search", { sessionKey: SESSION_B, messageChannel: "telegram" })?.("c3", {
      query: "q",
    });
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

// Every memory tool, with the client call it makes and the group argument it passes.
const TOOLS = [
  {
    name: "memory_search",
    params: { query: "q" },
    call: () => searchSpy,
    group: (a: unknown[]) => (a[1] as string[])[0],
  },
  {
    name: "graphiti_search",
    params: { query: "q" },
    call: () => searchSpy,
    group: (a: unknown[]) => (a[1] as string[])[0],
  },
  { name: "memory_recall", params: {}, call: () => episodesSpy, group: (a: unknown[]) => a[0] },
  { name: "graphiti_episodes", params: {}, call: () => episodesSpy, group: (a: unknown[]) => a[0] },
  {
    name: "memory_store",
    params: { text: "remember this" },
    call: () => addSpy,
    group: (a: unknown[]) => a[0],
  },
] as const;

// A verified caller's group: the opaque id of their identity scope key.
const verifiedGroup = (externalId: string) =>
  opaqueGroupId(externalIdScopeKey({ externalId }) as string);

// channel-sender on telegram: the group is the opaque id of "<provider>:<sender>".
const GROUP_A = opaqueGroupId("telegram:alice");
const GROUP_B = opaqueGroupId("telegram:bob");

describe.each(TOOLS)("$name: per-session scope", (tool) => {
  const run = (toolFor: ReturnType<typeof makeFakeApi>["toolFor"], ctx: ToolCtx) =>
    toolFor(tool.name, ctx)?.("c", tool.params);

  it("uses exactly the calling session's group", async () => {
    const { hooks, toolFor } = await setup();
    await startFor(hooks, SESSION_A);
    await startFor(hooks, SESSION_B);
    await run(toolFor, { sessionKey: SESSION_A, messageChannel: "telegram" });
    expect(tool.group(tool.call().mock.calls.at(-1) as unknown[])).toBe(GROUP_A);
    await run(toolFor, { sessionKey: SESSION_B, messageChannel: "telegram" });
    expect(tool.group(tool.call().mock.calls.at(-1) as unknown[])).toBe(GROUP_B);
  });

  it("refuses a session with no recorded group, without calling the client", async () => {
    const { hooks, toolFor } = await setup();
    await startFor(hooks, SESSION_A);
    const res = (await run(toolFor, { sessionKey: SESSION_B, messageChannel: "telegram" })) as {
      details: Record<string, unknown>;
    };
    expect(res.details.refused).toBe("no_session_group");
    expect(tool.call()).not.toHaveBeenCalled();
  });

  it("the shared main session gets no memory, whichever channels used it", async () => {
    const { hooks, toolFor } = await setup();
    for (const messageProvider of ["telegram", "whatsapp"]) {
      for (const h of hooks.before_agent_start ?? []) {
        await h({ prompt: "hello there" }, { sessionKey: "agent:main:main", messageProvider });
      }
    }
    const res = (await run(toolFor, {
      sessionKey: "agent:main:main",
      messageChannel: "whatsapp",
    })) as {
      details: Record<string, unknown>;
    };
    expect(res.details.refused).toBe("no_session_group");
    expect(tool.call()).not.toHaveBeenCalled();
  });

  it("the shared main session: tools get no memory even after verified callers", async () => {
    const { hooks, toolFor } = await setup();
    for (const externalId of ["user_a", "user_b"]) {
      for (const h of hooks.before_agent_start ?? []) {
        await h(
          { prompt: "hello there" },
          { sessionKey: "agent:main:main", messageProvider: "openai", externalId },
        );
      }
    }
    const res = (await run(toolFor, {
      sessionKey: "agent:main:main",
      messageChannel: "openai",
    })) as {
      details: Record<string, unknown>;
    };
    expect(res.details.refused).toBe("no_session_group");
    expect(tool.call()).not.toHaveBeenCalled();
  });

  it("a configured main key and the global session get no memory", async () => {
    const { hooks, toolFor } = await setup({}, { session: { mainKey: "primary" } });
    for (const sessionKey of ["agent:ops:primary", "global"]) {
      for (const h of hooks.before_agent_start ?? []) {
        await h({ prompt: "hello there" }, { sessionKey, messageProvider: "telegram" });
      }
      const res = (await run(toolFor, { sessionKey, messageChannel: "telegram" })) as {
        details: Record<string, unknown>;
      };
      expect(res.details.refused).toBe("no_session_group");
    }
    expect(tool.call()).not.toHaveBeenCalled();
  });

  it("two verified users sending the same session hint use their own groups", async () => {
    const { hooks, toolFor } = await setup();
    const hint = "h0123456789abcdef";
    const sessionOf = (user: string) => `agent:main:openai-user:${user}:${hint}`;
    for (const user of ["user_a", "user_b"]) {
      for (const h of hooks.before_agent_start ?? []) {
        await h(
          { prompt: "hello there" },
          { sessionKey: sessionOf(user), messageProvider: "openai", externalId: user },
        );
      }
    }
    for (const user of ["user_a", "user_b"]) {
      await run(toolFor, { sessionKey: sessionOf(user), messageChannel: "openai" });
      expect(tool.group(tool.call().mock.calls.at(-1) as unknown[])).toBe(verifiedGroup(user));
    }
  });

  it("refuses a call with no session, without calling the client", async () => {
    const { hooks, toolFor } = await setup();
    await startFor(hooks, SESSION_A);
    const res = (await run(toolFor, { messageChannel: "telegram" })) as {
      details: Record<string, unknown>;
    };
    expect(res.details.refused).toBe("no_session_group");
    expect(tool.call()).not.toHaveBeenCalled();
  });
});

describe("memory tools: recording", () => {
  it("a configured static userId is one shared group by design, main session included", async () => {
    const { toolFor } = await setup({ userId: "household" });
    await toolFor("memory_search", { sessionKey: "agent:main:main", messageChannel: "telegram" })?.(
      "c",
      { query: "q" },
    );
    expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual([opaqueGroupId("household")]);
  });

  // A message added to a running turn does not start a new turn, so the group
  // recorded at turn start must not depend on which member of a group sent it.
  it("a group session's group is the group's, whichever member starts the turn", async () => {
    const { hooks, toolFor } = await setup();
    const GROUP_SESSION = "agent:main:telegram:group:g1";
    const groupAs = async (senderId: string, senderE164: string) => {
      for (const h of hooks.before_agent_start ?? []) {
        await h(
          { prompt: "hello there" },
          { sessionKey: GROUP_SESSION, messageProvider: "telegram", senderId, senderE164 },
        );
      }
      await toolFor("memory_search", { sessionKey: GROUP_SESSION, messageChannel: "telegram" })?.(
        "c",
        { query: "q" },
      );
      return searchSpy.mock.calls.at(-1)?.[1];
    };
    expect(await groupAs("alice", "+15550001111")).toEqual([opaqueGroupId("telegram:g1")]);
    expect(await groupAs("bob", "+15550002222")).toEqual([opaqueGroupId("telegram:g1")]);
  });

  it("the auto-recall hook records the turn's group for its tools", async () => {
    const { hooks, toolFor } = await setup({ autoRecall: true });
    await startFor(hooks, SESSION_A);
    searchSpy.mockClear(); // the recall itself also searches
    await toolFor("memory_search", { sessionKey: SESSION_A, messageChannel: "telegram" })?.("c", {
      query: "q",
    });
    expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual([GROUP_A]);
  });

  it("past the session cap the oldest session is evicted and fails closed", async () => {
    const { hooks, toolFor } = await setup();
    await startFor(hooks, SESSION_A);
    for (let i = 0; i < 1000; i++) {
      await startFor(hooks, `agent:main:telegram:direct:user${i}`);
    }
    const res = (await toolFor("memory_search", {
      sessionKey: SESSION_A,
      messageChannel: "telegram",
    })?.("c", { query: "q" })) as { details: Record<string, unknown> };
    expect(res.details.refused).toBe("no_session_group");
    expect(searchSpy).not.toHaveBeenCalled();
    await toolFor("memory_search", {
      sessionKey: "agent:main:telegram:direct:user999",
      messageChannel: "telegram",
    })?.("c", { query: "q" });
    expect(searchSpy.mock.calls.at(-1)?.[1]).toEqual([opaqueGroupId("telegram:user999")]);
  });
});

describe("memory hooks: shared sessions and verified users", () => {
  const MAIN = "agent:main:main";
  // Recall ranks one search per turn; capture submits the turn's messages.
  let recallSpy: ReturnType<typeof vi.spyOn>;
  let captureSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    recallSpy = vi.spyOn(GraphitiRestClient.prototype, "searchRanked").mockResolvedValue([]);
    captureSpy = vi
      .spyOn(GraphitiRestClient.prototype, "submit")
      .mockRejectedValue(new Error("capture stops after submit in this test"));
  });
  const turnIn = async (
    hooks: Record<string, Hook[]>,
    ctx: Record<string, unknown>,
  ): Promise<void> => {
    for (const h of hooks.before_agent_start ?? []) {
      await h({ prompt: "what did I tell you about my sleep" }, ctx);
    }
    for (const h of hooks.agent_end ?? []) {
      await h({ success: true, messages: turn }, ctx);
    }
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  it("the shared main session: two senders, no recall and no capture", async () => {
    const { hooks } = await setup({ autoRecall: true });
    await turnIn(hooks, { sessionKey: MAIN, messageProvider: "telegram", senderId: "alice" });
    await turnIn(hooks, { sessionKey: MAIN, messageProvider: "telegram", senderId: "bob" });
    await flush();
    expect(recallSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("the shared main session: a verified caller still recalls and captures their own group", async () => {
    const { hooks } = await setup({ autoRecall: true });
    await turnIn(hooks, { sessionKey: MAIN, messageProvider: "openai", externalId: "user_x" });
    await flush();
    expect(recallSpy.mock.calls.at(-1)?.[0]).toBe(verifiedGroup("user_x"));
    expect(captureSpy.mock.calls.at(-1)?.[0]).toBe(verifiedGroup("user_x"));
  });

  it("the shared main session: a static userId still recalls and captures its group", async () => {
    const { hooks } = await setup({ autoRecall: true, userId: "household" });
    await turnIn(hooks, { sessionKey: MAIN, messageProvider: "telegram" });
    await flush();
    expect(recallSpy.mock.calls.at(-1)?.[0]).toBe(opaqueGroupId("household"));
    expect(captureSpy.mock.calls.at(-1)?.[0]).toBe(opaqueGroupId("household"));
  });

  it("two verified users sending the same session hint recall and capture their own groups", async () => {
    const { hooks } = await setup({ autoRecall: true });
    const hint = "h0123456789abcdef";
    for (const user of ["user_a", "user_b"]) {
      recallSpy.mockClear();
      captureSpy.mockClear();
      await turnIn(hooks, {
        sessionKey: `agent:main:openai-user:${user}:${hint}`,
        messageProvider: "openai",
        externalId: user,
      });
      await flush();
      expect(recallSpy.mock.calls.at(-1)?.[0]).toBe(verifiedGroup(user));
      expect(captureSpy.mock.calls.at(-1)?.[0]).toBe(verifiedGroup(user));
    }
  });
});
