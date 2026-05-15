/**
 * kg-mcp HTTP-client tests.
 *
 * Mocks `globalThis.fetch` to cover shrine-diet-bioactivity `/mcp`
 * communication without requiring a running kg-mcp instance.
 *
 * Mirrors `client.test.ts` (the SJ MCP client) — same JSON-RPC envelope,
 * same content-array unwrapping, same Bearer-auth contract — plus one
 * extra test for the paywall response shape introduced by ADR-001 §5
 * (kg-mcp tool handlers do atomic quota_check_and_debit and return a
 * structured paywall response when balance is insufficient).
 *
 * Live integration against an actual kg-mcp instance is gated by `LIVE=1`
 * in `kg-mcp-live.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callKgTool } from "./kg-client.js";

const BASE_URL = "https://kg-mcp-test.up.railway.app";
const TOKEN = "sj_test_token_abcdef";

describe("callKgTool", () => {
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

    await callKgTool(BASE_URL, TOKEN, "kg_food_to_bioactives", { food_name: "blueberries" });

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
    expect(body.params).toEqual({
      name: "kg_food_to_bioactives",
      arguments: { food_name: "blueberries" },
    });
    expect(typeof body.id).toBe("string");
  });

  it("unwraps a JSON content array and parses JSON payloads", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: {
            content: [
              {
                type: "text",
                text: '{"bioactives":[{"compound":"anthocyanin","concentration_mg":84.5}]}',
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const res = await callKgTool(BASE_URL, TOKEN, "kg_food_to_bioactives", {
      food_name: "blueberries",
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      bioactives: [{ compound: "anthocyanin", concentration_mg: 84.5 }],
    });
  });

  it("returns text data when the content payload isn't JSON", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: { content: [{ type: "text", text: "Curcumin is a polyphenol from turmeric." }] },
        }),
        { status: 200 },
      ),
    );

    const res = await callKgTool(BASE_URL, TOKEN, "kg_compound_lookup", {
      compound_name: "curcumin",
    });
    expect(res.ok).toBe(true);
    expect(res.data).toBe("Curcumin is a polyphenol from turmeric.");
  });

  it("surfaces JSON-RPC error envelopes", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          error: { code: -32000, message: "Compound not found" },
        }),
        { status: 200 },
      ),
    );

    const res = await callKgTool(BASE_URL, TOKEN, "kg_compound_lookup", { compound_name: "xyz" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Compound not found");
    expect(res.data).toBeNull();
  });

  it("returns ok=false with status + body for HTTP non-OK responses", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("Bearer token invalid", { status: 401 }),
    );

    const res = await callKgTool(BASE_URL, TOKEN, "kg_food_to_bioactives", { food_name: "apple" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/401/);
    expect(res.error).toMatch(/Bearer token invalid/);
  });

  it("returns ok=false on network failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ETIMEDOUT"));

    const res = await callKgTool(BASE_URL, TOKEN, "kg_food_to_bioactives", { food_name: "apple" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/ETIMEDOUT/);
  });

  it("handles raw JSON-RPC results without an MCP content array", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: { canonical_name: "curcumin", synonyms: ["diferuloylmethane"] },
        }),
        { status: 200 },
      ),
    );

    const res = await callKgTool(BASE_URL, TOKEN, "kg_compound_lookup", {
      compound_name: "curcumin",
    });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ canonical_name: "curcumin", synonyms: ["diferuloylmethane"] });
  });

  // -------------------------------------------------------------------------
  // ADR-001 §5 — atomic quota check on kg-mcp side returns a structured
  // paywall response (not an HTTP error). The client must surface this
  // shape unchanged so the agent's standard tool-result-rendering path
  // can render the paywall message.
  // -------------------------------------------------------------------------

  it("surfaces ADR-001 paywall response shape without rewriting it", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: {
            paywall: {
              reason: "insufficient_tau",
              required_tau: 1,
              current_balance_tau: 0,
              top_up_url: "https://syntropy.health/billing/topup",
            },
          },
        }),
        { status: 200 },
      ),
    );

    const res = await callKgTool(BASE_URL, TOKEN, "kg_compound_lookup", {
      compound_name: "curcumin",
    });
    expect(res.ok).toBe(true);
    // Paywall is a successful MCP response (not a JSON-RPC error). The
    // client passes the shape through to the agent which renders it.
    expect(res.data).toEqual({
      paywall: {
        reason: "insufficient_tau",
        required_tau: 1,
        current_balance_tau: 0,
        top_up_url: "https://syntropy.health/billing/topup",
      },
    });
  });
});
