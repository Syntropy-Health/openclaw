import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpSession,
  type McpToolDescriptor,
  type McpToolListResult,
  type McpToolResult,
} from "../../syntropy/src/client.js";
import {
  createSyntropyMcpPlugin,
  parseSyntropyMcpConfig,
  type SyntropyMcpOverrides,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolFactory = (ctx: Record<string, unknown>) => unknown;

type HookRegistration = {
  handler: (event: unknown, ctx?: unknown) => unknown;
  priority?: number;
};

function createFakeApi(pluginConfig?: Record<string, unknown>) {
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const toolFactories: ToolFactory[] = [];
  const hooks = new Map<string, HookRegistration[]>();

  const api = {
    id: "syntropy-mcp",
    name: "Syntropy MCP",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {},
    logger: {
      info: (m: string) => logs.info.push(m),
      warn: (m: string) => logs.warn.push(m),
      error: (m: string) => logs.error.push(m),
    },
    registerTool: (tool: unknown) => {
      toolFactories.push(tool as ToolFactory);
    },
    on: (hookName: string, handler: HookRegistration["handler"], opts?: { priority?: number }) => {
      const list = hooks.get(hookName) ?? [];
      list.push({ handler, priority: opts?.priority });
      hooks.set(hookName, list);
    },
  } as unknown as OpenClawPluginApi;

  const allLogs = () => [...logs.info, ...logs.warn, ...logs.error];
  return { api, logs, allLogs, toolFactories, hooks };
}

class FakeTimers {
  intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  timeouts: Array<{ fn: () => void; ms: number; cleared: boolean; fired: boolean }> = [];

  setIntervalFn = (fn: () => void, ms: number): unknown => {
    const handle = { fn, ms, cleared: false };
    this.intervals.push(handle);
    return handle;
  };
  clearIntervalFn = (handle: unknown): void => {
    (handle as { cleared: boolean }).cleared = true;
  };
  setTimeoutFn = (fn: () => void, ms: number): unknown => {
    const handle = { fn, ms, cleared: false, fired: false };
    this.timeouts.push(handle);
    return handle;
  };
  clearTimeoutFn = (handle: unknown): void => {
    (handle as { cleared: boolean }).cleared = true;
  };

  pendingTimeouts() {
    return this.timeouts.filter((t) => !t.fired && !t.cleared);
  }
  activeIntervals() {
    return this.intervals.filter((i) => !i.cleared);
  }
  async fireNextTimeout() {
    const next = this.pendingTimeouts()[0];
    if (!next) throw new Error("no pending timeout to fire");
    next.fired = true;
    next.fn();
    await flush();
  }
  async tickIntervals() {
    for (const interval of this.activeIntervals()) interval.fn();
    await flush();
  }
}

async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function descriptor(
  name: string,
  extra?: Partial<Pick<McpToolDescriptor, "description" | "inputSchema" | "annotations">>,
): McpToolDescriptor {
  return { name, description: `${name} tool`, ...extra };
}

function okList(tools: McpToolDescriptor[]): McpToolListResult {
  return { ok: true, tools };
}

const kgServer = {
  id: "kg",
  baseUrl: "http://kg.local",
  auth: "static-key",
  apiKeyEnv: "KG_MCP_API_KEY",
  label: "kg-mcp",
};

const sjM2mServer = {
  id: "sj",
  baseUrl: "http://sj.local",
  auth: "m2m-exchange",
  resource: "http://sj.local/mcp",
  exchangePath: "/tokens/exchange",
};

const baseConfig = (over?: Record<string, unknown>): Record<string, unknown> => ({
  servers: [kgServer],
  refreshSeconds: 300,
  maxStaleSeconds: 900,
  ...over,
});

// Injectable clock shared by catalog + plugin.
let nowMs: number;
const now = () => nowMs;

beforeEach(() => {
  nowMs = 1_000_000;
});

function setup(opts: {
  pluginConfig?: Record<string, unknown>;
  listTools?: SyntropyMcpOverrides["listTools"];
  callTool?: SyntropyMcpOverrides["callTool"];
  env?: NodeJS.ProcessEnv;
  timers?: FakeTimers;
}) {
  const timers = opts.timers ?? new FakeTimers();
  const listTools =
    opts.listTools ??
    vi.fn(async (): Promise<McpToolListResult> => okList([descriptor("log_food")]));
  const callTool =
    opts.callTool ??
    vi.fn(async (): Promise<McpToolResult> => ({ data: { done: true }, ok: true }));
  const env = opts.env ?? { KG_MCP_API_KEY: "kg_secret" };

  const plugin = createSyntropyMcpPlugin({
    listTools,
    callTool,
    env,
    now,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  const fake = createFakeApi(opts.pluginConfig);
  plugin.register(fake.api);
  return { ...fake, plugin, timers, listTools, callTool };
}

function factoryTools(ctx: ReturnType<typeof setup>): Array<Record<string, unknown>> {
  expect(ctx.toolFactories.length).toBe(1);
  const result = ctx.toolFactories[0]!({ sessionKey: "main" });
  if (result === null || result === undefined) return [];
  return result as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Config parsing + gating
// ---------------------------------------------------------------------------

describe("syntropy-mcp config", () => {
  it("parses the documented config shape with defaults", () => {
    const cfg = parseSyntropyMcpConfig({ servers: [kgServer, sjM2mServer] });
    expect(cfg.servers).toHaveLength(2);
    expect(cfg.refreshSeconds).toBe(300);
    expect(cfg.maxStaleSeconds).toBe(900); // 3 * refreshSeconds
    const parsed = parseSyntropyMcpConfig(baseConfig({ refreshSeconds: 60, maxStaleSeconds: 120 }));
    expect(parsed.refreshSeconds).toBe(60);
    expect(parsed.maxStaleSeconds).toBe(120);
  });

  it("rejects malformed server entries", () => {
    expect(() => parseSyntropyMcpConfig({ servers: [{ id: "kg" }] })).toThrow();
    expect(() =>
      parseSyntropyMcpConfig({ servers: [{ id: "kg", baseUrl: "http://x", auth: "nope" }] }),
    ).toThrow();
    // static-key requires apiKeyEnv; m2m-exchange requires resource.
    expect(() =>
      parseSyntropyMcpConfig({ servers: [{ id: "kg", baseUrl: "http://x", auth: "static-key" }] }),
    ).toThrow();
    expect(() =>
      parseSyntropyMcpConfig({
        servers: [{ id: "sj", baseUrl: "http://x", auth: "m2m-exchange" }],
      }),
    ).toThrow();
  });

  it("stays inert when no servers are configured", async () => {
    const ctx = setup({ pluginConfig: undefined });
    await flush();
    expect(ctx.toolFactories).toHaveLength(0);
    expect(ctx.hooks.size).toBe(0);
    expect(ctx.listTools).not.toHaveBeenCalled();
    expect(ctx.timers.activeIntervals()).toHaveLength(0);
    expect(ctx.logs.info.join("\n")).toContain("no servers configured");
  });

  it("disables itself (no registrations) on invalid config", async () => {
    const ctx = setup({ pluginConfig: { servers: [{ id: "kg" }] } });
    await flush();
    expect(ctx.toolFactories).toHaveLength(0);
    expect(ctx.hooks.size).toBe(0);
    expect(ctx.logs.error.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Discovery priming (fire-and-forget + retry/backoff)
// ---------------------------------------------------------------------------

describe("syntropy-mcp discovery priming", () => {
  it("kicks off catalog refresh at register without awaiting the network", async () => {
    let resolveList!: (v: McpToolListResult) => void;
    const gate = new Promise<McpToolListResult>((resolve) => {
      resolveList = resolve;
    });
    const listTools = vi.fn(() => gate);
    const ctx = setup({ pluginConfig: baseConfig(), listTools });

    // register() already returned; discovery is still in flight.
    expect(ctx.toolFactories).toHaveLength(1);
    await flush();
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(factoryTools(ctx)).toHaveLength(0); // nothing discovered yet

    resolveList(okList([descriptor("log_food")]));
    await flush();
    expect(factoryTools(ctx)).toHaveLength(1);
  });

  it("retries a failed prime with capped backoff, max 3 attempts", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => ({ ok: false, error: "kg tools/list HTTP 500" }),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools });
    await flush();
    expect(listTools).toHaveBeenCalledTimes(1);

    // Backoff timer scheduled for attempt 2 — exact exponential delays
    // (1000ms base doubling; the 30s cap is unreachable with 3 attempts).
    expect(ctx.timers.pendingTimeouts()).toHaveLength(1);
    expect(ctx.timers.pendingTimeouts()[0]!.ms).toBe(1000);
    await ctx.timers.fireNextTimeout();
    expect(listTools).toHaveBeenCalledTimes(2);

    expect(ctx.timers.pendingTimeouts()[0]!.ms).toBe(2000);
    await ctx.timers.fireNextTimeout();
    expect(listTools).toHaveBeenCalledTimes(3);

    // Attempt cap reached — no further retries scheduled.
    expect(ctx.timers.pendingTimeouts()).toHaveLength(0);
  });

  it("stops retrying once discovery succeeds", async () => {
    let fail = true;
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      if (fail) return { ok: false, error: "kg tools/list HTTP 500" };
      return okList([descriptor("log_food")]);
    });
    const ctx = setup({ pluginConfig: baseConfig(), listTools });
    await flush();
    fail = false;
    await ctx.timers.fireNextTimeout();
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(ctx.timers.pendingTimeouts()).toHaveLength(0);
    expect(factoryTools(ctx)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool factory + execute
// ---------------------------------------------------------------------------

describe("syntropy-mcp tool factory", () => {
  it("maps descriptors to executable tools whose execute round-trips tools/call", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> =>
        okList([
          descriptor("log_food", {
            inputSchema: {
              type: "object",
              properties: { food_name: { type: "string", description: "Food name" } },
              required: ["food_name"],
            },
          }),
        ]),
    );
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ data: { logged: true }, ok: true }),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools, callTool });
    await flush();

    const tools = factoryTools(ctx);
    expect(tools).toHaveLength(1);
    const tool = tools[0]! as {
      name: string;
      description: string;
      parameters: { type: string; properties?: Record<string, unknown> };
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    };
    expect(tool.name).toBe("log_food");
    expect(tool.description).toContain("log_food");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toHaveProperty("food_name");

    const result = await tool.execute("call-1", { food_name: "blueberries" });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(
      "http://kg.local",
      "kg_secret",
      "log_food",
      { food_name: "blueberries" },
      { label: "kg-mcp", session: expect.any(McpSession) },
    );
    expect(result.content[0]!.text).toContain("logged");
  });

  it("falls back to a permissive object schema when inputSchema is absent or unparseable", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> =>
        okList([
          descriptor("no_schema"),
          descriptor("bad_schema", { inputSchema: { type: "string" } }),
        ]),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools });
    await flush();

    const tools = factoryTools(ctx) as Array<{
      parameters: { type: string; additionalProperties?: boolean };
    }>;
    expect(tools).toHaveLength(2);
    for (const tool of tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).toBe(true);
    }
  });

  it("refreshes the server catalog and retries exactly once on an unknown-tool error", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("log_food")]),
    );
    const callTool = vi
      .fn<NonNullable<SyntropyMcpOverrides["callTool"]>>()
      .mockResolvedValueOnce({ data: null, ok: false, error: 'Unknown tool: "log_food"' })
      .mockResolvedValueOnce({ data: "second try ok", ok: true });
    const ctx = setup({ pluginConfig: baseConfig(), listTools, callTool });
    await flush();
    expect(listTools).toHaveBeenCalledTimes(1);

    const tools = factoryTools(ctx) as Array<{
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const result = await tools[0]!.execute("call-1", {});

    // Exactly 2 transport calls + 1 extra catalog refresh.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(result.content[0]!.text).toContain("second try ok");
  });

  it("TEST-B1-1: retry-also-fails is bounded to exactly one retry and surfaces the error", async () => {
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({
        data: null,
        ok: false,
        error: 'Unknown tool: "log_food"',
      }),
    );
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("log_food")]),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools, callTool });
    await flush();

    const tools = factoryTools(ctx);
    const tool = tools.find((t) => t.name === "log_food")!;
    const result = (await (tool.execute as (id: string, args: unknown) => Promise<unknown>)(
      "call1",
      {},
    )) as { content: Array<{ text?: string }> };

    // Exactly one retry: 2 transport calls total, 1 extra discovery refresh.
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(listTools).toHaveBeenCalledTimes(2); // prime + the refresh
    expect(result.content[0]?.text ?? "").toMatch(/Unknown tool/);
  });

  it("TEST-B1-2: execute fails closed (no transport call) when getToken rejects post-registration", async () => {
    const callTool = vi.fn(async (): Promise<McpToolResult> => ({ data: { ok: 1 }, ok: true }));
    const env: NodeJS.ProcessEnv = { KG_MCP_API_KEY: "kg_secret" };
    const ctx = setup({ pluginConfig: baseConfig(), callTool, env });
    await flush();

    const tool = factoryTools(ctx).find((t) => t.name === "log_food")!;
    // Simulate rotation-to-empty AFTER registration + discovery.
    delete env.KG_MCP_API_KEY;
    const result = (await (tool.execute as (id: string, args: unknown) => Promise<unknown>)(
      "call1",
      {},
    )) as { content: Array<{ text?: string }> };

    expect(callTool).not.toHaveBeenCalled();
    const text = result.content[0]?.text ?? "";
    expect(text).toMatch(/auth failed/);
    expect(text).not.toContain("kg_secret");
  });

  it("TEST-B1-3: a collision-prefixed tool executes against the UNPREFIXED wire name on its owning server", async () => {
    const env: NodeJS.ProcessEnv = { KG_MCP_API_KEY: "kg_secret", SJ_MCP_API_KEY: "sj_secret" };
    const twoServers = baseConfig({
      servers: [
        { ...kgServer },
        {
          id: "sj2",
          baseUrl: "http://sj2.local",
          auth: "static-key",
          apiKeyEnv: "SJ_MCP_API_KEY",
          label: "sj2-mcp",
        },
      ],
    });
    const listTools = vi.fn(async (): Promise<McpToolListResult> => okList([descriptor("search")]));
    const callTool = vi.fn(
      async (
        _baseUrl: string,
        _token: string,
        _toolName: string,
        _args: Record<string, unknown>,
        _opts: { label: string },
      ): Promise<McpToolResult> => ({ data: { hits: [] }, ok: true }),
    );
    const ctx = setup({ pluginConfig: twoServers, listTools, callTool, env });
    await flush();

    const tools = factoryTools(ctx);
    const prefixed = tools.find((t) => t.name === "sj2:search");
    expect(prefixed).toBeDefined();
    await (prefixed!.execute as (id: string, args: unknown) => Promise<unknown>)("call1", {});

    // The wire call must use the unprefixed name, on the OWNING server.
    const call = callTool.mock.calls.at(-1)!;
    expect(call[0]).toBe("http://sj2.local");
    expect(call[2]).toBe("search");
  });

  it("threads ONE McpSession per server through both discovery and execute", async () => {
    const discoverySessions: unknown[] = [];
    const executeSessions: unknown[] = [];
    const listTools = vi.fn(
      async (
        _baseUrl: string,
        _token: string,
        opts: { label: string; session?: McpSession },
      ): Promise<McpToolListResult> => {
        discoverySessions.push(opts.session);
        return okList([descriptor("log_food")]);
      },
    );
    const callTool = vi.fn(
      async (
        _baseUrl: string,
        _token: string,
        _toolName: string,
        _args: Record<string, unknown>,
        opts: { label: string; session?: McpSession },
      ): Promise<McpToolResult> => {
        executeSessions.push(opts.session);
        return { data: { done: true }, ok: true };
      },
    );
    const env: NodeJS.ProcessEnv = { KG_MCP_API_KEY: "kg_secret", SJ_MCP_API_KEY: "sj_secret" };
    const twoServers = baseConfig({
      servers: [
        { ...kgServer },
        {
          id: "sj2",
          baseUrl: "http://sj2.local",
          auth: "static-key",
          apiKeyEnv: "SJ_MCP_API_KEY",
          label: "sj2-mcp",
        },
      ],
    });
    const ctx = setup({ pluginConfig: twoServers, listTools, callTool, env });
    await flush();

    // Discovery received one distinct session instance per server.
    expect(discoverySessions).toHaveLength(2);
    expect(discoverySessions[0]).toBeInstanceOf(McpSession);
    expect(discoverySessions[1]).toBeInstanceOf(McpSession);
    expect(discoverySessions[0]).not.toBe(discoverySessions[1]);

    // Execute for each server reuses the SAME instance discovery used.
    const tools = factoryTools(ctx);
    const kgTool = tools.find((t) => t.name === "log_food")!;
    const sjTool = tools.find((t) => t.name === "sj2:log_food")!;
    await (kgTool.execute as (id: string, args: unknown) => Promise<unknown>)("c1", {});
    await (sjTool.execute as (id: string, args: unknown) => Promise<unknown>)("c2", {});
    expect(executeSessions).toHaveLength(2);
    expect(executeSessions[0]).toBe(discoverySessions[0]);
    expect(executeSessions[1]).toBe(discoverySessions[1]);
  });

  it("returns the error result without retrying for non-unknown-tool errors", async () => {
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ data: null, ok: false, error: "kg-mcp returned 500" }),
    );
    const ctx = setup({ pluginConfig: baseConfig(), callTool });
    await flush();
    expect(ctx.listTools).toHaveBeenCalledTimes(1);

    const tools = factoryTools(ctx) as Array<{
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const result = await tools[0]!.execute("call-1", {});
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(ctx.listTools).toHaveBeenCalledTimes(1); // no unknown-tool refresh
    expect(result.content[0]!.text).toContain("Error");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed isolation
// ---------------------------------------------------------------------------

describe("syntropy-mcp fail-closed isolation", () => {
  it("excludes a static-key server with missing env — one structured log, other servers unaffected", async () => {
    const listTools = vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
      if (baseUrl === "http://kg.local") return okList([descriptor("kg_search")]);
      return okList([descriptor("other_tool")]);
    });
    const brokenServer = {
      id: "sj",
      baseUrl: "http://sj.local",
      auth: "static-key",
      apiKeyEnv: "SJ_MCP_API_KEY", // NOT present in env
    };
    const ctx = setup({
      pluginConfig: baseConfig({ servers: [kgServer, brokenServer] }),
      listTools,
      env: { KG_MCP_API_KEY: "kg_secret" }, // SJ_MCP_API_KEY missing
    });
    await flush();

    // Broken server contributes no tools; healthy server unaffected.
    const tools = factoryTools(ctx) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["kg_search"]);
    // Discovery never even attempted for the broken server.
    for (const call of listTools.mock.calls) {
      expect(call[0]).toBe("http://kg.local");
    }
    // Exactly ONE structured log line about the broken server, no token values.
    const brokenLogs = ctx.allLogs().filter((l) => l.includes("SJ_MCP_API_KEY"));
    expect(brokenLogs).toHaveLength(1);
    expect(brokenLogs[0]).toContain('"sj"');
    expect(ctx.allLogs().join("\n")).not.toContain("kg_secret");
  });

  it("registers m2m-exchange servers fail-closed (zero tools, one structured plugin log, no throw)", async () => {
    const listTools = vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
      if (baseUrl === "http://kg.local") return okList([descriptor("kg_search")]);
      throw new Error("m2m server must never be listed without a token");
    });
    const ctx = setup({
      pluginConfig: baseConfig({ servers: [kgServer, sjM2mServer] }),
      listTools,
    });
    await flush();

    const tools = factoryTools(ctx) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["kg_search"]);

    // Exactly ONE plugin-level structured log for the placeholder.
    const placeholderLogs = ctx
      .allLogs()
      .filter((l) => l.includes("token exchange not implemented"));
    expect(placeholderLogs).toHaveLength(1);
    expect(placeholderLogs[0]).toContain('"sj"');
    expect(placeholderLogs[0]).toContain("B2");
  });
});

// ---------------------------------------------------------------------------
// before_agent_start context line
// ---------------------------------------------------------------------------

describe("syntropy-mcp before_agent_start", () => {
  it("prepends one short context line listing tool names when tools exist", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> =>
        okList([descriptor("log_food"), descriptor("kg_search")]),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools });
    await flush();

    const registrations = ctx.hooks.get("before_agent_start");
    expect(registrations).toHaveLength(1);
    expect(registrations![0]!.priority).toBe(30);

    const result = (await registrations![0]!.handler({}, {})) as { prependContext?: string };
    expect(result.prependContext).toBeDefined();
    expect(result.prependContext).toContain("log_food");
    expect(result.prependContext).toContain("kg_search");
    // Single line, not a wall of text.
    expect(result.prependContext!.trim()).not.toContain("\n");
  });

  it("prepends nothing when no tools were discovered", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => ({ ok: false, error: "kg tools/list HTTP 500" }),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools });
    await flush();

    const registrations = ctx.hooks.get("before_agent_start");
    const result = (await registrations![0]!.handler({}, {})) as { prependContext?: string };
    expect(result.prependContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Timer lifecycle
// ---------------------------------------------------------------------------

describe("syntropy-mcp timer lifecycle", () => {
  it("schedules a periodic interval at refreshSeconds and refreshes only when due", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("log_food")]),
    );
    const ctx = setup({ pluginConfig: baseConfig({ refreshSeconds: 300 }), listTools });
    await flush();
    expect(listTools).toHaveBeenCalledTimes(1);

    expect(ctx.timers.activeIntervals()).toHaveLength(1);
    expect(ctx.timers.activeIntervals()[0]!.ms).toBe(300_000);

    // Not yet due — tick does nothing.
    await ctx.timers.tickIntervals();
    expect(listTools).toHaveBeenCalledTimes(1);

    // Past refreshSeconds — tick refreshes.
    nowMs += 301_000;
    await ctx.timers.tickIntervals();
    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("gateway_stop clears the interval and any pending backoff timers", async () => {
    // Failing discovery so a backoff timeout is pending at stop time.
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => ({ ok: false, error: "kg tools/list HTTP 500" }),
    );
    const ctx = setup({ pluginConfig: baseConfig(), listTools });
    await flush();
    expect(ctx.timers.pendingTimeouts()).toHaveLength(1);
    expect(ctx.timers.activeIntervals()).toHaveLength(1);

    const stops = ctx.hooks.get("gateway_stop");
    expect(stops).toHaveLength(1);
    await stops![0]!.handler({}, {});

    expect(ctx.timers.activeIntervals()).toHaveLength(0);
    expect(ctx.timers.pendingTimeouts()).toHaveLength(0);
  });
});
