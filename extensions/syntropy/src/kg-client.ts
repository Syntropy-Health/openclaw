/**
 * HTTP client for calling shrine-diet-bioactivity kg-mcp tools.
 *
 * Mirrors `client.ts` (the SJ MCP client) — same `sj_*` Bearer token
 * (from Supabase Vault via openclaw#13), same JSON-RPC envelope, same
 * MCP content-array unwrapping. The extension calls the same kind of
 * MCP server on a different host; ADR-001 §2 says we use ONE token
 * type for server-to-server traffic.
 *
 * Per ADR-001 §5, kg-mcp tool handlers do atomic quota_check_and_debit
 * and return structured paywall responses (not HTTP errors) when the
 * user's τ-balance is insufficient. This client passes those shapes
 * through unchanged so the agent's standard tool-result rendering can
 * surface them to the user.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KgToolResult {
  data: unknown;
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Call a kg-mcp tool on behalf of a verified user.
 *
 * @param baseUrl    kg-mcp base URL (e.g., "https://kg-mcp-test.up.railway.app")
 * @param authToken  The user's stored `sj_*` API token — kg-mcp verifies via
 *                   the same shared Unkey instance SJ uses (ADR-001 §2.2).
 * @param toolName   MCP tool name (e.g., "kg_food_to_bioactives")
 * @param args       Tool arguments
 */
export async function callKgTool(
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<KgToolResult> {
  const url = `${baseUrl}/mcp`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { data: null, ok: false, error: `kg-mcp returned ${resp.status}: ${text}` };
    }

    const json = (await resp.json()) as Record<string, unknown>;

    // JSON-RPC error envelope
    if (json.error && typeof json.error === "object") {
      const err = json.error as { message?: string };
      return { data: null, ok: false, error: err.message ?? "kg-mcp tool error" };
    }

    // JSON-RPC success — unwrap MCP tool result
    const result = json.result ?? json;

    if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
      const content = (result as { content: Array<{ type: string; text?: string }> }).content;
      const textParts = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text as string);
      if (textParts.length > 0) {
        try {
          return { data: JSON.parse(textParts.join("")), ok: true };
        } catch {
          return { data: textParts.join(""), ok: true };
        }
      }
    }

    // Includes the ADR-001 §5 paywall response shape — passed through
    // unchanged so the agent's standard rendering path can surface it.
    return { data: result, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, ok: false, error: `kg-mcp call failed: ${msg}` };
  }
}
