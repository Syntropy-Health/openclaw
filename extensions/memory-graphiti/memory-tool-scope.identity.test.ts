/**
 * Memory tools under the identity strategy, with an identity store that knows
 * nobody: self-hosted scoping by session, and the cloud approval path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import { opaqueGroupId } from "./receipts.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

// The identity store knows nobody, so every turn is unidentified.
vi.mock("postgres", () => {
  const sql = Object.assign(() => Promise.resolve([]), {
    end: () => Promise.resolve(),
    begin: async (fn: (tx: unknown) => unknown) => fn(sql),
  });
  return { default: () => sql };
});

type ToolExec = (toolCallId: string, params: unknown) => Promise<unknown> | unknown;
type Hook = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const TOOLS = [
  { name: "memory_search", params: { query: "q" } },
  { name: "graphiti_search", params: { query: "q" } },
  { name: "memory_recall", params: {} },
  { name: "graphiti_episodes", params: {} },
  { name: "memory_store", params: { text: "remember this" } },
];
const SESSION = "agent:main:openresponses-user:u1";
const PEPPER = "k".repeat(64);

const CLOUD_APPROVAL = {
  backend: "zep-cloud",
  apiKey: "z_key",
  groupIdStrategy: "identity",
  databaseUrl: "postgres://mock/db",
  autoRecall: false,
  phiCloudApproval: {
    ruling: "a recorded ruling for this test case",
    approvalsRow: 1,
    date: "2026-01-01",
  },
};
const SELF_HOSTED_IDENTITY = {
  backend: "self-hosted",
  serverUrl: "http://localhost:8000",
  groupIdStrategy: "identity",
  databaseUrl: "postgres://mock/db",
  autoRecall: false,
};

async function setup(pluginConfig: Record<string, unknown>) {
  const registrations: unknown[] = [];
  const hooks: Record<string, Hook[]> = {};
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: { channels: {} },
    pluginConfig,
    runtime: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  const mod = await import("./index.js");
  await mod.default.register(api as never);
  const toolFor = (name: string, ctx: Record<string, unknown>): ToolExec | undefined => {
    for (const reg of registrations) {
      const out = typeof reg === "function" ? (reg as (c: unknown) => unknown)(ctx) : reg;
      for (const t of (Array.isArray(out) ? out : [out]) as Array<{
        name?: string;
        execute?: ToolExec;
      }>) {
        if (t?.name === name && typeof t.execute === "function") {
          return t.execute;
        }
      }
    }
    return undefined;
  };
  return { hooks, toolFor };
}

let spies: Array<ReturnType<typeof vi.spyOn>> = [];
let restSpies: Array<ReturnType<typeof vi.spyOn>> = [];
let restSearch: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // A valid key, so memory is not refused outright and the identity path runs.
  vi.stubEnv("OPENCLAW_MEMORY_GROUP_KEY", PEPPER);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network disabled in test");
    }),
  );
  spies = [
    vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]),
    vi.spyOn(ZepCloudClient.prototype, "getEpisodes").mockResolvedValue([]),
    vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined),
  ];
  restSearch = vi.spyOn(GraphitiRestClient.prototype, "searchFacts").mockResolvedValue([]);
  restSpies = [
    restSearch,
    vi.spyOn(GraphitiRestClient.prototype, "getEpisodes").mockResolvedValue([]),
    vi.spyOn(GraphitiRestClient.prototype, "addMessages").mockResolvedValue(undefined),
  ];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function start(hooks: Record<string, Hook[]>, ctx: Record<string, unknown>): Promise<void> {
  for (const h of hooks.before_agent_start ?? []) {
    await h({ prompt: "hello there" }, ctx);
  }
}

describe("memory tools under the cloud approval", () => {
  // On cloud the tool tripwire refuses before any group lookup; this pins that
  // reason. Scoping itself is covered by the self-hosted arms below.
  it.each(TOOLS)("$name: an unidentified turn is refused by the tripwire", async (tool) => {
    const { hooks, toolFor } = await setup(CLOUD_APPROVAL);
    await start(hooks, { sessionKey: SESSION, messageProvider: "shrinemobile" });
    const exec = toolFor(tool.name, { sessionKey: SESSION, messageChannel: "shrinemobile" });
    expect(exec).toBeDefined();
    const res = (await exec!("c", tool.params)) as { details: Record<string, unknown> };
    expect(res.details.refused).toBe("phi_tripwire");
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("memory tools under the identity strategy (self-hosted)", () => {
  it("a group session's group is the group's, whichever member starts the turn", async () => {
    const { hooks, toolFor } = await setup(SELF_HOSTED_IDENTITY);
    const GROUP_SESSION = "agent:main:telegram:group:g1";
    const groupAs = async (senderId: string, senderE164: string) => {
      await start(hooks, {
        sessionKey: GROUP_SESSION,
        messageProvider: "telegram",
        senderId,
        senderE164,
      });
      await toolFor("memory_search", { sessionKey: GROUP_SESSION, messageChannel: "telegram" })?.(
        "c",
        { query: "q" },
      );
      return restSearch.mock.calls.at(-1)?.[1];
    };
    const expected = [opaqueGroupId("telegram:g1", PEPPER)];
    expect(await groupAs("alice", "+15550001111")).toEqual(expected);
    expect(await groupAs("bob", "+15550002222")).toEqual(expected);
  });

  it.each(TOOLS)("$name: the shared main session gets no memory", async (tool) => {
    const { hooks, toolFor } = await setup(SELF_HOSTED_IDENTITY);
    await start(hooks, { sessionKey: "agent:main:main", messageProvider: "telegram" });
    await start(hooks, { sessionKey: "agent:main:main", messageProvider: "whatsapp" });
    const res = (await toolFor(tool.name, {
      sessionKey: "agent:main:main",
      messageChannel: "whatsapp",
    })?.("c", tool.params)) as { details: Record<string, unknown> };
    expect(res.details.refused).toBe("no_session_group");
    for (const spy of restSpies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("memory hooks under the identity strategy (self-hosted)", () => {
  it("a configured userId does not open the shared main session to unidentified turns", async () => {
    const recall = vi.spyOn(GraphitiRestClient.prototype, "searchRanked").mockResolvedValue([]);
    const capture = vi
      .spyOn(GraphitiRestClient.prototype, "submit")
      .mockRejectedValue(new Error("capture stops after submit in this test"));
    const { hooks } = await setup({
      ...SELF_HOSTED_IDENTITY,
      autoRecall: true,
      userId: "household",
    });
    for (const senderId of ["alice", "bob"]) {
      const ctx = { sessionKey: "agent:main:main", messageProvider: "telegram", senderId };
      for (const h of hooks.before_agent_start ?? []) {
        await h({ prompt: "what did I tell you about my sleep" }, ctx);
      }
      for (const h of hooks.agent_end ?? []) {
        await h(
          {
            success: true,
            messages: [
              { role: "user", content: "hello" },
              { role: "assistant", content: "hi" },
            ],
          },
          ctx,
        );
      }
    }
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(recall).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
