/**
 * Live kg-mcp connectivity test.
 *
 * Skipped by default — set `LIVE=1` in the environment to run.
 * Requires the kg-mcp Bearer token (from Infisical at
 * `/storefront/shrinelongevity/MCP_API_KEY` — see the parent monorepo's
 * `feedback_credentials_in_infisical.md` memory) and network access to
 * `https://kg-mcp-test.up.railway.app`.
 *
 * Two test layers:
 *   1. /health probe — verifies the Bearer-auth contract is honored
 *   2. Tool-call probes — exercise the 3 KG-direct MVP tools via callKgTool
 *      to confirm the JSON-RPC envelope contract matches what kg-mcp emits.
 *      Each tool is a smoke check, not a correctness gate — kg-mcp's own
 *      test suite owns response-shape verification.
 *
 * Paywall scenario (test-only Clerk user with 0τ) requires SJ_TEST_PAYWALL_TOKEN
 * to be set additionally. When unset, the paywall test skips with a note.
 */

import { describe, expect, it } from "vitest";
import { callKgTool } from "./kg-client.js";

const LIVE = process.env.LIVE === "1";
const KG_MCP_URL = process.env.KG_MCP_URL ?? "https://kg-mcp-test.up.railway.app";
const KG_MCP_TOKEN = process.env.KG_MCP_BEARER ?? process.env.MCP_API_KEY ?? "";
const PAYWALL_TOKEN = process.env.SJ_TEST_PAYWALL_TOKEN ?? "";

describe.skipIf(!LIVE)("kg-mcp (LIVE)", () => {
  it("requires KG_MCP_BEARER (or MCP_API_KEY) when LIVE=1", () => {
    expect(KG_MCP_TOKEN, "KG_MCP_BEARER missing — pull from Infisical").not.toBe("");
  });

  it("GET /health returns 200 with Bearer auth", async () => {
    const resp = await fetch(`${KG_MCP_URL}/health`, {
      headers: { Authorization: `Bearer ${KG_MCP_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    const status = resp.status;
    const body = status !== 200 ? await resp.text().catch(() => "") : "";
    expect(status, body).toBe(200);
  });

  it("GET /health without Bearer returns 200, 401, or 403 (contract drift if other)", async () => {
    const resp = await fetch(`${KG_MCP_URL}/health`, {
      signal: AbortSignal.timeout(15_000),
    });
    expect([200, 401, 403]).toContain(resp.status);
  });

  // -------------------------------------------------------------------------
  // SYN-33 — exercise the 3 KG-direct MVP tools via callKgTool
  // -------------------------------------------------------------------------

  it("kg_food_to_bioactives — round-trips JSON-RPC envelope", async () => {
    const res = await callKgTool(KG_MCP_URL, KG_MCP_TOKEN, "kg_food_to_bioactives", {
      food_name: "blueberries",
      max_results: 5,
    });
    // Either we get bioactive data back OR a structured paywall response.
    // Both are "ok=true" per the client contract; only protocol-level
    // failures (auth, network, tool-not-found) flip ok=false.
    expect(res.ok, res.error).toBe(true);
    expect(res.data).toBeDefined();
  });

  it("kg_compound_lookup — round-trips JSON-RPC envelope", async () => {
    const res = await callKgTool(KG_MCP_URL, KG_MCP_TOKEN, "kg_compound_lookup", {
      compound_name: "curcumin",
    });
    expect(res.ok, res.error).toBe(true);
    expect(res.data).toBeDefined();
  });

  it("kg_contraindication_check — round-trips JSON-RPC envelope", async () => {
    const res = await callKgTool(KG_MCP_URL, KG_MCP_TOKEN, "kg_contraindication_check", {
      supplements: ["curcumin"],
      medications: ["warfarin"],
    });
    expect(res.ok, res.error).toBe(true);
    expect(res.data).toBeDefined();
  });
});

// Paywall scenario — separate describe so it can independently skip when
// SJ_TEST_PAYWALL_TOKEN isn't provisioned (the test-only Clerk user with
// a 0τ balance). Requires LIVE=1 + paywall token.
describe.skipIf(!LIVE || !PAYWALL_TOKEN)("kg-mcp paywall (LIVE)", () => {
  it("returns ADR-001 §5 paywall shape when balance is insufficient", async () => {
    const res = await callKgTool(KG_MCP_URL, PAYWALL_TOKEN, "kg_compound_lookup", {
      compound_name: "curcumin",
    });
    expect(res.ok).toBe(true);
    // Per ADR-001 §5, paywall response is a successful MCP response with
    // a structured `paywall` body — not an HTTP error or JSON-RPC error.
    const data = res.data as { paywall?: { reason: string; current_balance_tau: number } };
    expect(data.paywall, "expected paywall shape in result body").toBeDefined();
    expect(data.paywall!.reason).toBe("insufficient_tau");
    expect(data.paywall!.current_balance_tau).toBe(0);
  });
});
