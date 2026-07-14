import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_COMPONENT_MARKER as CORE_COMPONENT_MARKER } from "../../../src/agents/pi-embedded-runner/run/payloads.js";
import {
  McpSession,
  type McpToolDescriptor,
  type McpToolListResult,
  type McpToolResult,
} from "../../syntropy/src/client.js";
import type { ConfirmGovernor } from "./governor.js";
import {
  createSyntropyMcpPlugin,
  isUnauthorizedError,
  OPENCLAW_COMPONENT_MARKER,
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
  baseUrl: "https://sj.local",
  auth: "m2m-exchange",
  resource: "https://sj.local/mcp",
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

  it("rejects maxStaleSeconds < refreshSeconds (PR#56: incoherent freshness window)", () => {
    expect(() =>
      parseSyntropyMcpConfig(baseConfig({ refreshSeconds: 300, maxStaleSeconds: 120 })),
    ).toThrow(/maxStaleSeconds must be >= refreshSeconds/);
    // equal is allowed (boundary).
    expect(
      parseSyntropyMcpConfig(baseConfig({ refreshSeconds: 300, maxStaleSeconds: 300 }))
        .maxStaleSeconds,
    ).toBe(300);
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

  // B2 (was the B1 placeholder test): the m2m-exchange path is now REAL, but
  // absent a machine secret AND with no injected actor provider, discovery's
  // actor token throws (fail-closed) so the server still yields zero tools —
  // and never lists tools without a credential, exactly like before.
  it("m2m-exchange with no machine secret fails closed (zero tools, no unauthenticated discovery, no throw)", async () => {
    const listTools = vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
      if (baseUrl === "http://kg.local") return okList([descriptor("kg_search")]);
      throw new Error("m2m server must never be listed without a token");
    });
    const ctx = setup({
      pluginConfig: baseConfig({ servers: [kgServer, sjM2mServer] }),
      listTools,
      env: { KG_MCP_API_KEY: "kg_secret" }, // no CLERK_MACHINE_SECRET_KEY
    });
    await flush();

    // Only the healthy static-key server contributes tools; sj is fail-closed.
    const tools = factoryTools(ctx) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["kg_search"]);
    // Discovery for the m2m server never reached listTools (actor token threw).
    for (const call of listTools.mock.calls) expect(call[0]).toBe("http://kg.local");
    // One structured plugin log marking the m2m server enabled-but-fail-closed.
    const m2mLogs = ctx.allLogs().filter((l) => l.includes("m2m-exchange") && l.includes('"sj"'));
    expect(m2mLogs.length).toBeGreaterThanOrEqual(1);
    expect(m2mLogs.some((l) => l.includes("fail-closed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B2 — m2m-exchange token-exchange wiring
// ---------------------------------------------------------------------------

/** An actor-token provider stub (mirrors the ServiceAuthProvider surface). */
function fakeActorProvider(token = "actor.m2m.jwt") {
  return {
    getToken: vi.fn(async () => token),
    get secretMissing() {
      return false;
    },
  };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Decode a fake minted JWT's payload — the injectable verify seam for tests. */
const decodeMinted = async (jwt: string): Promise<Record<string, unknown>> =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));

/**
 * Build a Tier-2 minted-token exchange Response for a `requestedSubject`
 * ("<channel>:<externalId>"). SJ mints `sub` = the RESOLVED Clerk id and echoes
 * the requested `channel` in a separate claim (#2951); the client binds on
 * channel + tier, not on sub.
 */
function mintedExchangeResponse(requestedSubject: string): Response {
  const iat = Math.floor(nowMs / 1000);
  const channel = requestedSubject.includes(":")
    ? requestedSubject.split(":")[0]!
    : requestedSubject;
  const claims = {
    sub: `clerk_${requestedSubject}`, // resolved Clerk id (not the composed request)
    act: { sub: "machine_openclaw" },
    channel,
    aud: "https://sj.local/mcp",
    iss: "https://sj.local",
    iat,
    exp: iat + 1800,
    tier: 2,
  };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: `${b64url({ alg: "RS256", kid: "sj-1" })}.${b64url(claims)}.sig`,
      issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_type: "Bearer",
      expires_in: 1800,
    }),
    text: async () => "",
  } as unknown as Response;
}

const sjExchangeServer = {
  id: "sj",
  baseUrl: "https://sj.local",
  auth: "m2m-exchange",
  resource: "https://sj.local/mcp",
  exchangePath: "/api/tokens/exchange",
  machineSub: "machine_openclaw",
  issuer: "https://sj.local",
  label: "sj-mcp",
};

function setupExchange(opts: {
  actorProvider?: ReturnType<typeof fakeActorProvider> | null;
  exchangeFetch?: typeof fetch;
  listTools?: SyntropyMcpOverrides["listTools"];
  callTool?: SyntropyMcpOverrides["callTool"];
  env?: NodeJS.ProcessEnv;
  /** Override the m2m server spec (SEC-HTTPS / disable-path tests). */
  server?: Record<string, unknown>;
}) {
  const timers = new FakeTimers();
  const listTools =
    opts.listTools ??
    vi.fn(async (): Promise<McpToolListResult> => okList([descriptor("sj_search")]));
  const callTool =
    opts.callTool ?? vi.fn(async (): Promise<McpToolResult> => ({ data: { ok: 1 }, ok: true }));
  const plugin = createSyntropyMcpPlugin({
    listTools,
    callTool,
    env: opts.env ?? {},
    now,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    serviceAuthProvider: opts.actorProvider,
    exchangeFetch: opts.exchangeFetch,
    verifyMintedToken: decodeMinted,
  });
  const fake = createFakeApi(baseConfig({ servers: [opts.server ?? sjExchangeServer] }));
  plugin.register(fake.api);
  return { ...fake, plugin, timers, listTools, callTool };
}

describe("syntropy-mcp m2m-exchange wiring (B2)", () => {
  it("a valid mocked exchange yields a working getToken — execute calls with the exchanged user token", async () => {
    const actor = fakeActorProvider();
    const exchangeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sub = new URLSearchParams(init!.body as string).get("requested_subject")!;
      return mintedExchangeResponse(sub);
    }) as unknown as typeof fetch;
    const callTool = vi.fn(async (): Promise<McpToolResult> => ({ data: { hits: [] }, ok: true }));

    const ctx = setupExchange({ actorProvider: actor, exchangeFetch, callTool });
    await flush();

    // Discovery used the ACTOR token (machine op, no user in scope).
    expect(actor.getToken).toHaveBeenCalled();

    // A verified user runs a tool → the exchanged user token is used on the wire.
    const hook = ctx.hooks.get("before_agent_start")![0]!;
    await hook.handler({ prompt: "search" }, { sessionKey: "s1", externalId: "user_A" });
    // The tool ctx carries the message channel → Tier-2 channel-scoped subject.
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<unknown>;
    }>;
    const tool = tools.find((t) => t.name === "sj_search")!;
    await tool.execute("c1", { q: "x" });

    // The exchange endpoint was hit with a channel-scoped requested_subject and
    // the token handed to callTool is the minted (3-segment) JWT — NOT the actor.
    const exchangeCalls = (exchangeFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(exchangeCalls.length).toBeGreaterThanOrEqual(1);
    expect(exchangeCalls[0]![0]).toBe("https://sj.local/api/tokens/exchange");
    const sentSubject = new URLSearchParams(
      (exchangeCalls[0]![1] as RequestInit).body as string,
    ).get("requested_subject");
    expect(sentSubject).toBe("telegram:user_A");
    const bearer = (callTool.mock.calls.at(-1) as unknown as unknown[])[1] as string;
    expect(bearer.split(".")).toHaveLength(3);
    expect(bearer).not.toBe("actor.m2m.jwt");
  });

  it("no externalId → fail-closed (getToken rejects, no exchange, no transport call)", async () => {
    const actor = fakeActorProvider();
    const exchangeFetch = vi.fn(async () =>
      mintedExchangeResponse("nobody"),
    ) as unknown as typeof fetch;
    const callTool = vi.fn(async (): Promise<McpToolResult> => ({ data: {}, ok: true }));

    const ctx = setupExchange({ actorProvider: actor, exchangeFetch, callTool });
    await flush();

    // No before_agent_start identity cached → the tool factory sees no externalId.
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const tool = tools.find((t) => t.name === "sj_search")!;
    const result = await tool.execute("c1", {});

    // Fail-closed: exchange never attempted, transport never called, auth-failed surfaced.
    expect(exchangeFetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(result.content[0]?.text ?? "").toMatch(/auth failed/);
  });

  it("missing machine secret (no injected provider) → fail-closed, zero tools", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      throw new Error("must never list without a credential");
    });
    // serviceAuthProvider omitted → default provider built from env; no secret present.
    const ctx = setupExchange({ listTools, env: {} });
    await flush();

    const entries = ctx.toolFactories[0]!({ sessionKey: "s1" });
    expect(entries).toBeNull();
    // The default provider's getToken threw (secretMissing) before any listTools.
    expect(listTools).not.toHaveBeenCalled();
  });

  it("Tier 2 request shape: requested_subject='<channel>:<externalId>', no subject_token", async () => {
    const actor = fakeActorProvider();
    const exchangeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sub = new URLSearchParams(init!.body as string).get("requested_subject")!;
      return mintedExchangeResponse(sub);
    }) as unknown as typeof fetch;

    const ctx = setupExchange({ actorProvider: actor, exchangeFetch });
    await flush();
    const hook = ctx.hooks.get("before_agent_start")![0]!;
    await hook.handler({ prompt: "search" }, { sessionKey: "s1", externalId: "user_A" });
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<unknown>;
    }>;
    await tools.find((t) => t.name === "sj_search")!.execute("c1", {});

    const init = (exchangeFetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as RequestInit;
    const p = new URLSearchParams(init.body as string);
    expect(p.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(p.get("actor_token")).toBe("actor.m2m.jwt");
    expect(p.get("resource")).toBe("https://sj.local/mcp");
    // Channel-scoped subject (SJ removed the bare-externalId path).
    expect(p.get("requested_subject")).toBe("telegram:user_A");
    expect(p.has("subject_token")).toBe(false);
  });

  it("Tier 2 with NO channel → fail-closed (no exchange, no transport call)", async () => {
    const actor = fakeActorProvider();
    const exchangeFetch = vi.fn(async () =>
      mintedExchangeResponse("nobody"),
    ) as unknown as typeof fetch;
    const callTool = vi.fn(async (): Promise<McpToolResult> => ({ data: {}, ok: true }));

    const ctx = setupExchange({ actorProvider: actor, exchangeFetch, callTool });
    await flush();
    const hook = ctx.hooks.get("before_agent_start")![0]!;
    await hook.handler({ prompt: "search" }, { sessionKey: "s1", externalId: "user_A" });
    // Factory ctx WITHOUT messageChannel → Tier-2 cannot compose a subject.
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const result = await tools.find((t) => t.name === "sj_search")!.execute("c1", {});

    expect(exchangeFetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(result.content[0]?.text ?? "").toMatch(/auth failed/);
  });
});

// ---------------------------------------------------------------------------
// B2 QG hardening — SEC-HTTPS, DESIGN-MACHINESUB, disable paths, 401-retry
// ---------------------------------------------------------------------------

describe("syntropy-mcp m2m-exchange QG hardening (B2)", () => {
  it("SEC-HTTPS: an http:// (non-local) baseUrl m2m server is disabled (zero tools, structured log)", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      throw new Error("must never list a cleartext m2m server");
    });
    const ctx = setupExchange({
      actorProvider: fakeActorProvider(),
      listTools,
      server: { ...sjExchangeServer, baseUrl: "http://sj.local", resource: "http://sj.local/mcp" },
    });
    await flush();
    expect(ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" })).toBeNull();
    expect(listTools).not.toHaveBeenCalled();
    const log = ctx.allLogs().find((l) => l.includes('"sj"') && l.includes("https"));
    expect(log).toBeTruthy();
    expect(log).toContain("fail-closed");
  });

  it("SEC-HTTPS: an https:// baseUrl m2m server works", async () => {
    const actor = fakeActorProvider();
    const exchangeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sub = new URLSearchParams(init!.body as string).get("requested_subject")!;
      return mintedExchangeResponse(sub);
    }) as unknown as typeof fetch;
    const ctx = setupExchange({ actorProvider: actor, exchangeFetch });
    await flush();
    const tools = ctx.toolFactories[0]!({
      sessionKey: "s1",
      messageChannel: "telegram",
    }) as unknown[];
    expect(tools).not.toBeNull();
    expect((tools as Array<{ name: string }>).some((t) => t.name === "sj_search")).toBe(true);
  });

  it("SEC-HTTPS: an http://localhost baseUrl is permitted (dev/tests)", async () => {
    const ctx = setupExchange({
      actorProvider: fakeActorProvider(),
      server: {
        ...sjExchangeServer,
        baseUrl: "http://localhost",
        resource: "http://localhost/mcp",
        issuer: "http://localhost",
      },
    });
    await flush();
    const tools = ctx.toolFactories[0]!({
      sessionKey: "s1",
      messageChannel: "telegram",
    }) as unknown[];
    expect(tools).not.toBeNull();
    expect((tools as Array<{ name: string }>).some((t) => t.name === "sj_search")).toBe(true);
  });

  it("DESIGN-MACHINESUB: no machineSub (config or env) → server disabled, zero tools", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      throw new Error("must never list without a machineSub binding");
    });
    const { machineSub: _drop, ...noMachineSub } = sjExchangeServer;
    const ctx = setupExchange({
      actorProvider: fakeActorProvider(),
      listTools,
      env: {}, // no SYNTROPY_MCP_MACHINE_SUB
      server: noMachineSub,
    });
    await flush();
    expect(ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" })).toBeNull();
    expect(listTools).not.toHaveBeenCalled();
    expect(ctx.allLogs().some((l) => l.includes('"sj"') && l.includes("machineSub"))).toBe(true);
  });

  it("TEST-ISSUER-DISABLE: no issuer (config or env) → zero tools, listTools never called, disable log", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      throw new Error("must never list without an issuer binding");
    });
    const { issuer: _drop, ...noIssuer } = sjExchangeServer;
    const ctx = setupExchange({
      actorProvider: fakeActorProvider(),
      listTools,
      env: {}, // no SYNTROPY_MCP_TOKEN_ISS
      server: noIssuer,
    });
    await flush();
    expect(ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" })).toBeNull();
    expect(listTools).not.toHaveBeenCalled();
    expect(ctx.allLogs().some((l) => l.includes('"sj"') && l.includes("issuer"))).toBe(true);
  });

  it("TEST-ACTOR-DISABLE: default provider path with a non-URL resource → server disabled, zero tools", async () => {
    const listTools = vi.fn(async (): Promise<McpToolListResult> => {
      throw new Error("must never list a server whose actor config is invalid");
    });
    // No injected serviceAuthProvider → default buildActorProvider path;
    // a non-URL resource makes resolveServiceAuthConfig throw → null → disabled.
    const ctx = setupExchange({
      listTools,
      env: { CLERK_MACHINE_SECRET_KEY: "ak_test" },
      server: { ...sjExchangeServer, resource: "not-a-url" },
    });
    await flush();
    expect(ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" })).toBeNull();
    expect(listTools).not.toHaveBeenCalled();
    expect(ctx.allLogs().some((l) => l.includes('"sj"') && l.includes("actor-token"))).toBe(true);
  });

  it("TEST-401-RETRY: a 401 at tool call → invalidate + re-exchange + retry once (same channel key)", async () => {
    const actor = fakeActorProvider();
    const exchangeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const sub = new URLSearchParams(init!.body as string).get("requested_subject")!;
      return mintedExchangeResponse(sub);
    }) as unknown as typeof fetch;
    // First tool call → 401-shaped; second → success.
    const callTool = vi
      .fn<NonNullable<SyntropyMcpOverrides["callTool"]>>()
      .mockResolvedValueOnce({ data: null, ok: false, error: "HTTP 401 unauthorized" })
      .mockResolvedValueOnce({ data: { hits: [] }, ok: true });

    const ctx = setupExchange({ actorProvider: actor, exchangeFetch, callTool });
    await flush();
    const hook = ctx.hooks.get("before_agent_start")![0]!;
    await hook.handler({ prompt: "search" }, { sessionKey: "s1", externalId: "user_A" });
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1", messageChannel: "telegram" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ content: Array<{ text?: string }> }>;
    }>;
    const result = await tools.find((t) => t.name === "sj_search")!.execute("c1", {});

    // Bounded to exactly one retry: 2 tool calls, 2 exchanges (initial + re-exchange).
    expect(callTool).toHaveBeenCalledTimes(2);
    const exCalls = (exchangeFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(exCalls.length).toBe(2);
    // Both exchanges used the SAME channel-scoped subject (a slack 401 wouldn't
    // drop a telegram entry — the invalidate is keyed on this subject).
    for (const call of exCalls) {
      const p = new URLSearchParams((call[1] as RequestInit).body as string);
      expect(p.get("requested_subject")).toBe("telegram:user_A");
    }
    expect(result.content[0]?.text ?? "").not.toMatch(/auth failed/);
  });
});

describe("isUnauthorizedError vocabulary", () => {
  it.each(["HTTP 401", "kg unauthorized", "invalid_token", "invalid token", "token expired"])(
    "treats %s as a re-exchange trigger",
    (msg) => {
      expect(isUnauthorizedError(msg)).toBe(true);
    },
  );
  it.each(["kg returned 500", "", undefined])("does NOT trigger on %s", (msg) => {
    expect(isUnauthorizedError(msg as string | undefined)).toBe(false);
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

// ---------------------------------------------------------------------------
// B4 Confirm Governor wiring
// ---------------------------------------------------------------------------

function foodDescriptor() {
  return {
    type: "component",
    key: "food_confirm",
    props: {},
    ui: {
      summary: "Log salmon, 340 kcal?",
      commit_tool: "syntropy_log_food",
      fields: [
        { name: "food_name", type: "string", value: "salmon" },
        { name: "calories", type: "number", value: 340, constraints: { min: 0 } },
      ],
    },
  };
}

const kgWithCommit = (over?: Record<string, unknown>) =>
  baseConfig({
    servers: [{ ...kgServer, commitTools: ["syntropy_log_food"] }],
    ...over,
  });

async function fireAgentStart(
  ctx: ReturnType<typeof setup>,
  prompt: string,
  hookCtx: { sessionKey?: string; externalId?: string | null },
) {
  const hook = ctx.hooks.get("before_agent_start")![0]!;
  return hook.handler({ prompt }, hookCtx);
}

function guardHook(ctx: ReturnType<typeof setup>) {
  const list = ctx.hooks.get("before_tool_call");
  expect(list).toBeDefined();
  return list![0]!;
}

describe("syntropy-mcp config — commitTools allowlist", () => {
  it("parses a per-server commitTools array", () => {
    const cfg = parseSyntropyMcpConfig(kgWithCommit());
    expect(cfg.servers[0]!.commitTools).toEqual(["syntropy_log_food"]);
  });

  it("rejects a non-array / non-string commitTools", () => {
    expect(() =>
      parseSyntropyMcpConfig(baseConfig({ servers: [{ ...kgServer, commitTools: "x" }] })),
    ).toThrow();
    expect(() =>
      parseSyntropyMcpConfig(baseConfig({ servers: [{ ...kgServer, commitTools: [1, 2] }] })),
    ).toThrow();
  });
});

describe("syntropy-mcp before_tool_call guard wiring", () => {
  it("registers the guard at priority 40", async () => {
    const ctx = setup({ pluginConfig: kgWithCommit() });
    await flush();
    expect(guardHook(ctx).priority).toBe(40);
  });

  it("blocks an unconfirmed commit tool and passes read tools through", async () => {
    const ctx = setup({ pluginConfig: kgWithCommit() });
    await flush();
    await fireAgentStart(ctx, "hi", { sessionKey: "s1", externalId: "user_A" });

    const guard = guardHook(ctx);
    const blocked = await guard.handler(
      { toolName: "syntropy_log_food", params: { food_name: "x" } },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect((blocked as { block?: boolean }).block).toBe(true);

    const read = await guard.handler(
      { toolName: "analyze_food", params: {} },
      { sessionKey: "s1", toolName: "analyze_food" },
    );
    expect(read).toBeUndefined();
  });
});

describe("syntropy-mcp preview → confirm → commit round-trip", () => {
  it("mints on the initiate result, stages on CONFIRM, and binds the commit args", async () => {
    // analyze_food is the discovered INITIATE tool; its result carries the C1
    // descriptor whose commit_tool is the allowlisted syntropy_log_food.
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
    );
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ ok: true, data: { component: foodDescriptor() } }),
    );
    const ctx = setup({ pluginConfig: kgWithCommit(), listTools, callTool });
    await flush();

    // Cache the verified identity for this session.
    await fireAgentStart(ctx, "analyze my salmon", { sessionKey: "s1", externalId: "user_A" });

    // Run the initiate tool — execute marks the stamped descriptor for the bridge.
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ details?: unknown }>;
    }>;
    const analyze = tools.find((t) => t.name === "analyze_food")!;
    const result = await analyze.execute("call1", { food_name: "salmon" });
    const marker = (result.details as Record<string, unknown>).__openclaw_component as {
      type: string;
      component: { ui: { pending_id: string } };
    };
    expect(marker.type).toBe("component");
    const pendingId = marker.component.ui.pending_id;
    expect(pendingId).toMatch(/^cnf_/);

    // The user's CONFIRM turn stages a validated edit (calories 340 → 350).
    await fireAgentStart(ctx, `<CONFIRM pending_id=${pendingId} fields={"calories":350}>`, {
      sessionKey: "s1",
      externalId: "user_A",
    });

    // The commit is bound to previewArgs ⊕ the staged edit — model junk discarded.
    const committed = await guardHook(ctx).handler(
      {
        toolName: "syntropy_log_food",
        params: { food_name: "HACKED", calories: 99999, pending_id: pendingId },
      },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect(committed).toEqual({ params: { food_name: "salmon", calories: 350 } });

    // Replay of the same pending is blocked (single-use).
    const replay = await guardHook(ctx).handler(
      { toolName: "syntropy_log_food", params: { pending_id: pendingId } },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect((replay as { block?: boolean }).block).toBe(true);
  });

  it("CODE-STALE-EXTID (#2): an identity DOWNGRADE on the same session blocks a replayed commit", async () => {
    // Session verifies user_A (pending minted + staged); a later turn on the
    // SAME sessionKey arrives UNVERIFIED (externalId absent). The cached
    // externalId MUST be cleared so the model cannot replay the pending_id from
    // the transcript and commit on a turn with NO verified identity.
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
    );
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ ok: true, data: { component: foodDescriptor() } }),
    );
    const ctx = setup({ pluginConfig: kgWithCommit(), listTools, callTool });
    await flush();

    // Turn 1 — verified user_A mints a pending via the initiate tool.
    await fireAgentStart(ctx, "analyze my salmon", { sessionKey: "s1", externalId: "user_A" });
    const tools = ctx.toolFactories[0]!({ sessionKey: "s1" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ details?: unknown }>;
    }>;
    const analyze = tools.find((t) => t.name === "analyze_food")!;
    const result = await analyze.execute("call1", { food_name: "salmon" });
    const marker = (result.details as Record<string, unknown>).__openclaw_component as {
      component: { ui: { pending_id: string } };
    };
    const pendingId = marker.component.ui.pending_id;
    // Stage it (confirm-as-previewed).
    await fireAgentStart(ctx, `<CONFIRM pending_id=${pendingId} fields={}>`, {
      sessionKey: "s1",
      externalId: "user_A",
    });

    // Turn 2 — SAME session, but the caller is now UNVERIFIED (downgrade).
    await fireAgentStart(ctx, "log it", { sessionKey: "s1", externalId: undefined });

    // The model replays the transcript-known pending_id. With the stale cache
    // cleared, the guard resolves no externalId ⇒ BLOCK (not committed).
    const committed = await guardHook(ctx).handler(
      { toolName: "syntropy_log_food", params: { pending_id: pendingId } },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect((committed as { block?: boolean }).block).toBe(true);
    expect((committed as { params?: unknown }).params).toBeUndefined();
  });

  it("does not mint a pending for a caller without a verified externalId", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
    );
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ ok: true, data: { component: foodDescriptor() } }),
    );
    const ctx = setup({ pluginConfig: kgWithCommit(), listTools, callTool });
    await flush();

    // before_agent_start with no externalId ⇒ nothing cached for the session.
    await fireAgentStart(ctx, "analyze", { sessionKey: "s1", externalId: null });

    const tools = ctx.toolFactories[0]!({ sessionKey: "s1" }) as Array<{
      name: string;
      execute: (id: string, args: unknown) => Promise<{ details?: unknown }>;
    }>;
    const analyze = tools.find((t) => t.name === "analyze_food")!;
    const result = await analyze.execute("call1", { food_name: "salmon" });
    // No marker — no gating capability without a verified identity (fail-closed).
    expect((result.details as Record<string, unknown>).__openclaw_component).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B4 hardening — guard-throw, re-prompt, forged marker, marker drift
// ---------------------------------------------------------------------------

function runAnalyze(ctx: ReturnType<typeof setup>) {
  const tools = ctx.toolFactories[0]!({ sessionKey: "s1" }) as Array<{
    name: string;
    execute: (id: string, args: unknown) => Promise<{ details?: unknown }>;
  }>;
  return tools.find((t) => t.name === "analyze_food")!;
}

async function mintPendingId(ctx: ReturnType<typeof setup>): Promise<string> {
  await fireAgentStart(ctx, "analyze my salmon", { sessionKey: "s1", externalId: "user_A" });
  const result = await runAnalyze(ctx).execute("call1", { food_name: "salmon" });
  const marker = (result.details as Record<string, unknown>).__openclaw_component as {
    component: { ui: { pending_id: string } };
  };
  return marker.component.ui.pending_id;
}

describe("syntropy-mcp guard hardening", () => {
  it("TEST-GUARD-THROW: a throwing guard fails closed for a commit tool, passes reads", async () => {
    const fakeGovernor = {
      parseConfirmTurn: () => ({ handled: false }),
      preview: () => null,
      guardBeforeToolCall: () => {
        throw new Error("boom");
      },
      isGatedCommitTool: (name: string) => name === "syntropy_log_food",
    } as unknown as ConfirmGovernor;

    const timers = new FakeTimers();
    const plugin = createSyntropyMcpPlugin({
      listTools: vi.fn(
        async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
      ),
      callTool: vi.fn(async (): Promise<McpToolResult> => ({ data: {}, ok: true })),
      env: { KG_MCP_API_KEY: "kg_secret" },
      now,
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      governor: fakeGovernor,
    });
    const fake = createFakeApi(kgWithCommit());
    plugin.register(fake.api);
    await flush();

    const guard = fake.hooks.get("before_tool_call")![0]!;
    const blocked = await guard.handler(
      { toolName: "syntropy_log_food", params: {} },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect((blocked as { block?: boolean; blockReason?: string }).block).toBe(true);
    expect((blocked as { blockReason?: string }).blockReason).toBeTruthy();

    const read = await guard.handler(
      { toolName: "analyze_food", params: {} },
      { sessionKey: "s1", toolName: "analyze_food" },
    );
    expect(read).toBeUndefined();
  });

  it("DESIGN-REPROMPT (#5): an invalid edit blocks the commit and surfaces a re-prompt note", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
    );
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ ok: true, data: { component: foodDescriptor() } }),
    );
    const ctx = setup({ pluginConfig: kgWithCommit(), listTools, callTool });
    await flush();
    const pendingId = await mintPendingId(ctx);

    // Invalid edit (calories below min 0) — parse rejects, nothing staged.
    const startResult = (await fireAgentStart(
      ctx,
      `<CONFIRM pending_id=${pendingId} fields={"calories":-5}>`,
      { sessionKey: "s1", externalId: "user_A" },
    )) as { prependContext?: string };
    expect(startResult.prependContext).toContain("not applied");

    // No silent commit of the un-edited preview values — the guard blocks.
    const committed = await guardHook(ctx).handler(
      { toolName: "syntropy_log_food", params: { pending_id: pendingId } },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect((committed as { block?: boolean }).block).toBe(true);
  });

  it("DESIGN-REPROMPT (#5): a valid empty confirm ({}) commits the preview values", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
    );
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({ ok: true, data: { component: foodDescriptor() } }),
    );
    const ctx = setup({ pluginConfig: kgWithCommit(), listTools, callTool });
    await flush();
    const pendingId = await mintPendingId(ctx);

    await fireAgentStart(ctx, `<CONFIRM pending_id=${pendingId} fields={}>`, {
      sessionKey: "s1",
      externalId: "user_A",
    });
    const committed = await guardHook(ctx).handler(
      { toolName: "syntropy_log_food", params: { food_name: "junk", pending_id: pendingId } },
      { sessionKey: "s1", toolName: "syntropy_log_food" },
    );
    expect(committed).toEqual({ params: { food_name: "salmon", calories: 340 } });
  });

  it("SEC-FORGE-MARKER (#6): a backend-supplied marker does not survive a non-gated result", async () => {
    const listTools = vi.fn(
      async (): Promise<McpToolListResult> => okList([descriptor("analyze_food")]),
    );
    // Backend forges a marker AND uses a non-allowlisted commit_tool (preview→null).
    const forged = {
      type: "component",
      key: "food_confirm",
      props: {},
      ui: { summary: "forged", commit_tool: "not_allowlisted" },
    };
    const callTool = vi.fn(
      async (): Promise<McpToolResult> => ({
        ok: true,
        data: { component: forged, __openclaw_component: { type: "component", component: forged } },
      }),
    );
    const ctx = setup({ pluginConfig: kgWithCommit(), listTools, callTool });
    await flush();
    await fireAgentStart(ctx, "analyze", { sessionKey: "s1", externalId: "user_A" });
    const result = await runAnalyze(ctx).execute("call1", { food_name: "salmon" });
    // The forged marker was stripped before preview; preview added none.
    expect((result.details as Record<string, unknown>).__openclaw_component).toBeUndefined();
  });

  it("DESIGN-MARKER-DRIFT: the extension marker literal matches the core payloads marker", () => {
    expect(OPENCLAW_COMPONENT_MARKER).toBe(CORE_COMPONENT_MARKER);
  });
});
