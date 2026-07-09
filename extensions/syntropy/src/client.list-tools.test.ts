/**
 * `listMcpTools` (MCP `tools/list` discovery) tests.
 *
 * Mocks `globalThis.fetch` to cover the shared JSON-RPC-over-HTTP transport's
 * tool-discovery path without a running MCP server. Asserts:
 *   - JSON-RPC `tools/list` envelope shape + Bearer auth header
 *   - Happy-path mapping of `result.tools` entries (incl. annotations passthrough)
 *   - Entries without a string `name` are skipped, not fatal
 *   - HTTP non-2xx handling
 *   - JSON-RPC error envelope handling
 *   - Malformed result (missing `tools`) handling
 *   - Network failure and non-JSON response handling
 *   - The auth token never leaks into error strings
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMcpTools } from "./client.js";

const BASE_URL = "http://localhost:3000";
const TOKEN = "sj_test_token_abcdef";
const LABEL = "kg-mcp";

function jsonRpcResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", ...payload }), { status });
}

describe("listMcpTools", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a well-formed JSON-RPC tools/list request with Bearer auth", async () => {
    const mockFetch = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(jsonRpcResponse({ result: { tools: [] } }));

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/mcp`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init?.body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/list");
    expect(body.params).toEqual({});
    expect(typeof body.id).toBe("string");
  });

  it("maps result.tools entries to McpToolDescriptor, passing annotations through", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonRpcResponse({
        result: {
          tools: [
            {
              name: "log_food",
              description: "Log a food item",
              inputSchema: { type: "object", properties: { food_name: { type: "string" } } },
              annotations: { readOnlyHint: false, title: "Log Food" },
            },
            {
              name: "kg_search",
              description: "Search the knowledge graph",
              inputSchema: { type: "object" },
            },
          ],
        },
      }),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.tools).toHaveLength(2);
    expect(res.tools[0]).toEqual({
      name: "log_food",
      description: "Log a food item",
      inputSchema: { type: "object", properties: { food_name: { type: "string" } } },
      annotations: { readOnlyHint: false, title: "Log Food" },
    });
    expect(res.tools[1]).toEqual({
      name: "kg_search",
      description: "Search the knowledge graph",
      inputSchema: { type: "object" },
    });
  });

  it("skips entries without a string name instead of failing", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonRpcResponse({
        result: {
          tools: [
            { description: "nameless" },
            { name: 42, description: "numeric name" },
            { name: "valid_tool" },
          ],
        },
      }),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0]!.name).toBe("valid_tool");
  });

  it("returns ok=false with label + status on HTTP 401", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("Bearer token missing", { status: 401 }),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe(`${LABEL} tools/list HTTP 401`);
    expect(res.error).not.toContain(TOKEN);
  });

  it("surfaces JSON-RPC error envelopes with label", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      jsonRpcResponse({ error: { code: -32000, message: "Invalid token" } }),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toBe(`${LABEL} tools/list error: Invalid token`);
    expect(res.error).not.toContain(TOKEN);
  });

  it("returns ok=false when result is missing a tools array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(jsonRpcResponse({ result: { nope: true } }));

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain(LABEL);
    expect(res.error).not.toContain(TOKEN);
  });

  it("returns ok=false (never throws) on network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain("ECONNREFUSED");
    expect(res.error).not.toContain(TOKEN);
  });

  it("sends the MCP-required Accept header (application/json, text/event-stream)", async () => {
    const mockFetch = vi
      .mocked(globalThis.fetch)
      .mockResolvedValue(jsonRpcResponse({ result: { tools: [] } }));

    await listMcpTools(BASE_URL, TOKEN, { label: LABEL });

    const [, init] = mockFetch.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Accept"]).toBe("application/json, text/event-stream");
  });

  it("parses an SSE-framed (text/event-stream) tools/list response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":"1","result":{"tools":[{"name":"kg_query"}]}}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0]!.name).toBe("kg_query");
  });

  it("returns ok=false (never throws) on an SSE body with no data: line", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("event: message\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain(LABEL);
    expect(res.error).not.toContain(TOKEN);
  });

  it("returns ok=false (never throws) on a non-JSON response body", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("<html>gateway error</html>", { status: 200 }),
    );

    const res = await listMcpTools(BASE_URL, TOKEN, { label: LABEL });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toContain(LABEL);
    expect(res.error).not.toContain(TOKEN);
  });
});
