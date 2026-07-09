/**
 * `McpSession` — lazily-established MCP streamable-http session support for
 * the shared transport (`callMcpTool` / `listMcpTools`).
 *
 * Mocks `globalThis.fetch` with a stateful fake MCP server. Asserts:
 *   - With a session, the first call performs `initialize` (correct envelope,
 *     NO session header on it), captures `mcp-session-id` from the response
 *     headers, sends the `notifications/initialized` notification, and
 *     attaches the session header to the actual request
 *   - The session id is cached: no second initialize on subsequent calls
 *   - `ensure` is single-flighted under concurrency (exactly one initialize)
 *   - Stateless servers (initialize response WITHOUT `mcp-session-id`):
 *     requests proceed with no session header and no expired-session retry
 *   - Expired-session recovery: HTTP 400 with a session attached →
 *     invalidate + re-initialize (new id) + retry EXACTLY once
 *   - Initialize failure (HTTP 500) → structured error, never a throw
 *   - Regression pin: without `opts.session` there is NO initialize call and
 *     NO `mcp-session-id` header (the stateless SJ path is byte-identical)
 *   - The auth token and session id never leak into error strings
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callMcpTool, listMcpTools, McpSession } from "./client.js";

const BASE_URL = "http://localhost:3000";
const TOKEN = "sj_test_token_abcdef";
const LABEL = "kg-mcp";

type RecordedCall = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * Stateful fake MCP server behind a fetch mock.
 * - `sessionIds`: id handed out per `initialize` (null = stateless, no header)
 * - `requestStatuses`: HTTP status per tools/list | tools/call request (default 200)
 * - `initializeStatus`: HTTP status for every `initialize` (default 200)
 */
function fakeMcpServer(opts: {
  sessionIds?: Array<string | null>;
  requestStatuses?: number[];
  initializeStatus?: number;
}) {
  let initCount = 0;
  let requestCount = 0;
  const impl = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
    if (body.method === "initialize") {
      const status = opts.initializeStatus ?? 200;
      if (status !== 200) return new Response("initialize rejected", { status });
      const sid = (opts.sessionIds ?? ["sess-1", "sess-2"])[initCount] ?? null;
      initCount += 1;
      const headers: Record<string, string> = {};
      if (sid !== null) headers["mcp-session-id"] = sid;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "fake-kg-mcp", version: "1" },
          },
        }),
        { status: 200, headers },
      );
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    // tools/list or tools/call
    const status = (opts.requestStatuses ?? [])[requestCount] ?? 200;
    requestCount += 1;
    if (status !== 200) {
      return new Response("Missing session ID", { status });
    }
    if (body.method === "tools/list") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "kg_query" }] } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: '{"answer":42}' }] },
      }),
      { status: 200 },
    );
  };
  return vi.fn(impl);
}

function recordedCalls(): RecordedCall[] {
  return vi.mocked(globalThis.fetch).mock.calls.map(([url, init]) => ({
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
  }));
}

function callsByMethod(method: string): RecordedCall[] {
  return recordedCalls().filter((call) => call.body.method === method);
}

describe("McpSession", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("initializes on first use: correct envelope, no session header, then attaches the captured id", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({ sessionIds: ["sess-1"] }));
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.tools[0]!.name).toBe("kg_query");

    // Exactly one initialize, sent WITHOUT a session header, WITH Bearer auth.
    const inits = callsByMethod("initialize");
    expect(inits).toHaveLength(1);
    const init = inits[0]!;
    expect(init.url).toBe(`${BASE_URL}/mcp`);
    expect(init.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(init.headers["Accept"]).toBe("application/json, text/event-stream");
    expect(init.headers["mcp-session-id"]).toBeUndefined();
    expect(init.body.jsonrpc).toBe("2.0");
    const params = init.body.params as Record<string, unknown>;
    expect(params.protocolVersion).toBe("2025-03-26");
    expect(params.capabilities).toEqual({});
    expect(params.clientInfo).toEqual({ name: "openclaw-syntropy-mcp", version: "1.0" });
    expect(typeof init.body.id).toBe("string");

    // The initialized notification carries the session header and no id.
    const notes = callsByMethod("notifications/initialized");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.headers["mcp-session-id"]).toBe("sess-1");
    expect(notes[0]!.body.id).toBeUndefined();

    // The tools/list request carries the captured session id.
    const lists = callsByMethod("tools/list");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("honors a custom clientName", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({}));
    const session = new McpSession(BASE_URL, { clientName: "custom-client" });

    await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });

    const init = callsByMethod("initialize")[0]!;
    const params = init.body.params as { clientInfo: { name: string } };
    expect(params.clientInfo.name).toBe("custom-client");
  });

  it("caches the session id: a second call performs no second initialize", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({ sessionIds: ["sess-1"] }));
    const session = new McpSession(BASE_URL);

    await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    const res2 = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res2.ok).toBe(true);

    expect(callsByMethod("initialize")).toHaveLength(1);
    const lists = callsByMethod("tools/list");
    expect(lists).toHaveLength(2);
    expect(lists[1]!.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("single-flights concurrent ensure calls (exactly one initialize)", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({ sessionIds: ["sess-1"] }));
    const session = new McpSession(BASE_URL);

    const [a, b] = await Promise.all([
      listMcpTools(BASE_URL, TOKEN, { label: LABEL, session }),
      listMcpTools(BASE_URL, TOKEN, { label: LABEL, session }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(callsByMethod("initialize")).toHaveLength(1);
  });

  it("stateless server (no mcp-session-id header): calls proceed without a session header", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({ sessionIds: [null] }));
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(true);

    const lists = callsByMethod("tools/list");
    expect(lists).toHaveLength(1);
    expect(lists[0]!.headers["mcp-session-id"]).toBeUndefined();

    // Cached: the stateless outcome is remembered, no re-initialize.
    await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(callsByMethod("initialize")).toHaveLength(1);
  });

  it("stateless server: a 400 is NOT retried (no expired-session loop without a session header)", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      fakeMcpServer({ sessionIds: [null], requestStatuses: [400] }),
    );
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe(`${LABEL} tools/list HTTP 400`);
    expect(callsByMethod("tools/list")).toHaveLength(1);
    expect(callsByMethod("initialize")).toHaveLength(1);
  });

  it("expired session: 400 → invalidate + re-initialize (new id) + retry exactly once → success", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      fakeMcpServer({ sessionIds: ["sess-1", "sess-2"], requestStatuses: [400, 200] }),
    );
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(true);

    expect(callsByMethod("initialize")).toHaveLength(2);
    const lists = callsByMethod("tools/list");
    expect(lists).toHaveLength(2);
    expect(lists[0]!.headers["mcp-session-id"]).toBe("sess-1");
    expect(lists[1]!.headers["mcp-session-id"]).toBe("sess-2");
  });

  it("persistent 400 after the retry → structured error, exactly 2 tools/list attempts", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      fakeMcpServer({ sessionIds: ["sess-1", "sess-2"], requestStatuses: [400, 400] }),
    );
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe(`${LABEL} tools/list HTTP 400`);
    expect(res.error).not.toContain(TOKEN);
    expect(res.error).not.toContain("sess-");
    expect(callsByMethod("tools/list")).toHaveLength(2);
    expect(callsByMethod("initialize")).toHaveLength(2);
  });

  it("expired-session recovery also applies to 404", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      fakeMcpServer({ sessionIds: ["sess-1", "sess-2"], requestStatuses: [404, 200] }),
    );
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(true);
    expect(callsByMethod("tools/list")).toHaveLength(2);
  });

  it("initialize failure (500) surfaces a structured error, never a throw, no token/sid leak", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({ initializeStatus: 500 }));
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain(LABEL);
    expect(res.error).toContain("500");
    expect(res.error).not.toContain(TOKEN);
    expect(callsByMethod("tools/list")).toHaveLength(0);

    // A failed initialize is not cached — the next call tries again.
    await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(callsByMethod("initialize")).toHaveLength(2);
  });

  it("parses an SSE-framed initialize response", async () => {
    let first = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;
      if (body.method === "initialize") {
        expect(first).toBe(true);
        first = false;
        return new Response(
          `event: message\ndata: {"jsonrpc":"2.0","id":"${body.id}","result":{"protocolVersion":"2025-03-26"}}\n\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "mcp-session-id": "sse-sess" },
          },
        );
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }), {
        status: 200,
      });
    });
    const session = new McpSession(BASE_URL);

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL, session });
    expect(res.ok).toBe(true);
    expect(callsByMethod("tools/list")[0]!.headers["mcp-session-id"]).toBe("sse-sess");
  });

  it("callMcpTool with a session attaches the header and recovers an expired session once", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(
      fakeMcpServer({ sessionIds: ["sess-1", "sess-2"], requestStatuses: [400, 200] }),
    );
    const session = new McpSession(BASE_URL);

    const res = await callMcpTool(
      BASE_URL,
      TOKEN,
      "kg_query",
      { q: "x" },
      {
        label: LABEL,
        session,
      },
    );
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ answer: 42 });

    const calls = callsByMethod("tools/call");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers["mcp-session-id"]).toBe("sess-1");
    expect(calls[1]!.headers["mcp-session-id"]).toBe("sess-2");
    expect(callsByMethod("initialize")).toHaveLength(2);
  });

  it("regression pin (SJ path): no opts.session means no initialize and no session header", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(fakeMcpServer({}));

    const listRes = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(listRes.ok).toBe(true);
    const callRes = await callMcpTool(BASE_URL, TOKEN, "kg_query", {}, { label: LABEL });
    expect(callRes.ok).toBe(true);

    expect(callsByMethod("initialize")).toHaveLength(0);
    expect(callsByMethod("notifications/initialized")).toHaveLength(0);
    for (const call of recordedCalls()) {
      expect(call.headers["mcp-session-id"]).toBeUndefined();
    }
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });
});
