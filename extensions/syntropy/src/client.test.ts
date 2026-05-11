/**
 * SJ MCP HTTP-client tests.
 *
 * Mocks `globalThis.fetch` to cover Syntropy-Journal `/mcp` communication
 * without requiring a running SJ instance. Asserts:
 *   - JSON-RPC envelope shape
 *   - Bearer auth header
 *   - Successful unwrap of MCP `content` arrays
 *   - JSON-RPC error envelope handling
 *   - HTTP non-OK response handling
 *   - Network failure handling
 *
 * Live integration against an actual SJ instance is gated by `LIVE=1` —
 * see `sj-api-live.test.ts` for the live counterpart.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callSyntropyTool } from "./client.js";

const BASE_URL = "http://localhost:3000";
const TOKEN = "sj_test_token_abcdef";

describe("callSyntropyTool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a well-formed JSON-RPC tools/call request to /mcp", async () => {
    const mockFetch = vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: { content: [] }, id: "x" }), {
        status: 200,
      }),
    );

    await callSyntropyTool(BASE_URL, TOKEN, "log_food", { food_name: "apple" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/mcp`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(init?.body as string);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params).toEqual({ name: "log_food", arguments: { food_name: "apple" } });
    expect(typeof body.id).toBe("string");
  });

  it("unwraps a JSON content array and parses JSON payloads", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: {
            content: [{ type: "text", text: '{"meal_id":42,"calories":95}' }],
          },
        }),
        { status: 200 },
      ),
    );

    const res = await callSyntropyTool(BASE_URL, TOKEN, "log_food", {});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ meal_id: 42, calories: 95 });
  });

  it("returns text data when the content payload isn't JSON", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: { content: [{ type: "text", text: "OK, logged your snack." }] },
        }),
        { status: 200 },
      ),
    );

    const res = await callSyntropyTool(BASE_URL, TOKEN, "log_food", {});
    expect(res.ok).toBe(true);
    expect(res.data).toBe("OK, logged your snack.");
  });

  it("surfaces JSON-RPC error envelopes", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          error: { code: -32000, message: "Invalid token" },
        }),
        { status: 200 },
      ),
    );

    const res = await callSyntropyTool(BASE_URL, TOKEN, "log_food", {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Invalid token");
    expect(res.data).toBeNull();
  });

  it("returns ok=false with status + body for HTTP non-OK responses", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("Bearer token missing", { status: 401 }),
    );

    const res = await callSyntropyTool(BASE_URL, TOKEN, "log_food", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/401/);
    expect(res.error).toMatch(/Bearer token missing/);
  });

  it("returns ok=false on network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await callSyntropyTool(BASE_URL, TOKEN, "log_food", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it("handles raw JSON-RPC results without an MCP content array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { ok: true, count: 3 } }), {
        status: 200,
      }),
    );

    const res = await callSyntropyTool(BASE_URL, TOKEN, "syntropy_my_checkins", {});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ ok: true, count: 3 });
  });
});
