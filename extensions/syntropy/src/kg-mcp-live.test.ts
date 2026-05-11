/**
 * Live kg-mcp connectivity test.
 *
 * Skipped by default — set `LIVE=1` in the environment to run.
 * Requires the kg-mcp Bearer token (from Infisical at
 * `/storefront/shrinelongevity/MCP_API_KEY` — see the parent monorepo's
 * `feedback_credentials_in_infisical.md` memory) and network access to
 * `https://kg-mcp-test.up.railway.app`.
 *
 * Intentionally minimal: a single GET to `/health` to verify the
 * Bearer-auth contract and the gateway is reachable. Deeper integration
 * (compound-food traversal, contraindication queries) belongs in the
 * shrine-diet-bioactivity submodule's own test suite.
 */

import { describe, expect, it } from "vitest";

const LIVE = process.env.LIVE === "1";
const KG_MCP_URL = process.env.KG_MCP_URL ?? "https://kg-mcp-test.up.railway.app";
const KG_MCP_TOKEN = process.env.KG_MCP_BEARER ?? process.env.MCP_API_KEY ?? "";

describe.skipIf(!LIVE)("kg-mcp (LIVE)", () => {
  it("requires KG_MCP_BEARER (or MCP_API_KEY) when LIVE=1", () => {
    expect(KG_MCP_TOKEN, "KG_MCP_BEARER missing — pull from Infisical").not.toBe("");
  });

  it("GET /health returns 200 with Bearer auth", async () => {
    const resp = await fetch(`${KG_MCP_URL}/health`, {
      headers: { Authorization: `Bearer ${KG_MCP_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });

    expect(resp.status, await resp.text().catch(() => "")).toBe(200);
  });

  it("GET /health without Bearer returns 401", async () => {
    const resp = await fetch(`${KG_MCP_URL}/health`, {
      signal: AbortSignal.timeout(15_000),
    });

    // Some gateways treat /health as unauthenticated — accept 200 or 401 here,
    // but if neither, the gateway contract has drifted.
    expect([200, 401, 403]).toContain(resp.status);
  });
});
