/**
 * The shipped openclaw.json is copied into /data/openclaw.json on every Fly boot
 * (scripts/fly/bootstrap-config.mjs syncs the plugins block). Its only plane is
 * STAGING, so it must point at the TEST Syntropy-Journals plane — never a prod host —
 * and never at a dead host. [CTO #13250, 2026-10-02]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { callMcpToolWithServiceAuth, callSyntropyTool } from "./client.js";
import { callKgTool } from "./kg-client.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const text = readFileSync(resolve(ROOT, "openclaw.json"), "utf8");
const cfg = JSON.parse(text) as {
  plugins: { entries: Record<string, { config?: Record<string, unknown> }> };
};
const TEST_SJ = "https://syntropy-api-test.shrinelongevity.com";

describe("shipped openclaw.json — staging talks to the TEST SJ plane", () => {
  it("references no production SJ host anywhere", () => {
    expect(text).not.toMatch(/syntropy-api-production/);
    expect(text).not.toMatch(/shrine-api-production/);
    expect(text).not.toMatch(/https:\/\/(api\.)?(shrinelongevity\.com|syntropyhealth\.bio)/);
  });

  it("syntropy plugin and pairing verify point at the test plane", () => {
    expect(cfg.plugins.entries.syntropy?.config?.syntropyBaseUrl).toBe(TEST_SJ);
    const auth = cfg.plugins.entries["persist-user-identity"]?.config?.auth as Record<
      string,
      unknown
    >;
    expect(auth.passcodeVerifyUrl).toBe(`${TEST_SJ}/api/ext/pairing/verify`);
  });

  it("no user-lookup URL: SJ has no /api/ext/users/search route (absent, not a dead link)", () => {
    const auth = cfg.plugins.entries["persist-user-identity"]?.config?.auth as Record<
      string,
      unknown
    >;
    expect(auth).not.toHaveProperty("userLookupUrl");
  });
});

describe("MCP endpoint path per server", () => {
  function captureFetch() {
    const urls: string[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    return { urls, spy };
  }

  it("SJ user-token calls go to /mcp/ (trailing slash), tolerating a trailing slash on base", async () => {
    const { urls, spy } = captureFetch();
    await callSyntropyTool(TEST_SJ, "sj_x_y", "log_food", {});
    await callSyntropyTool(`${TEST_SJ}/`, "sj_x_y", "log_food", {});
    spy.mockRestore();
    expect(urls).toEqual([`${TEST_SJ}/mcp/`, `${TEST_SJ}/mcp/`]);
  });

  it("SJ service-auth calls go to /mcp/", async () => {
    const { urls, spy } = captureFetch();
    await callMcpToolWithServiceAuth(
      TEST_SJ,
      { getToken: async () => "m2m" },
      "t",
      {},
      { label: "SJ" },
    );
    spy.mockRestore();
    expect(urls).toEqual([`${TEST_SJ}/mcp/`]);
  });

  it("kg-mcp keeps its existing /mcp path (different server, unchanged)", async () => {
    const { urls, spy } = captureFetch();
    await callKgTool("https://kg.example", "sj_x_y", "t", {});
    spy.mockRestore();
    expect(urls).toEqual(["https://kg.example/mcp"]);
  });
});
