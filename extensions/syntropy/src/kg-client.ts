/**
 * HTTP client for calling shrine-diet-bioactivity kg-mcp tools.
 *
 * A thin wrapper over the shared `callMcpTool` transport in `client.ts` — same
 * `sj_*` Bearer token (from Supabase Vault via openclaw#13), same JSON-RPC
 * envelope, same MCP content-array unwrapping. kg-mcp is the same kind of MCP
 * server on a different host; ADR-001 §2 uses ONE token type for
 * server-to-server traffic.
 *
 * Per ADR-001 §5, kg-mcp tool handlers do atomic quota_check_and_debit and
 * return structured paywall responses (not HTTP errors) when the user's
 * τ-balance is insufficient. `callMcpTool` passes those shapes through unchanged
 * so the agent's standard tool-result rendering can surface them.
 */

import { callMcpTool, type McpToolResult } from "./client.js";

/** Result of a kg-mcp tool call. Alias of {@link McpToolResult}. */
export type KgToolResult = McpToolResult;

/**
 * Call a kg-mcp tool on behalf of a verified user.
 *
 * @param baseUrl    kg-mcp base URL (e.g., "https://kg-mcp-test.up.railway.app")
 * @param authToken  The user's stored `sj_*` API token — kg-mcp verifies via
 *                   the same shared Unkey instance SJ uses (ADR-001 §2.2).
 * @param toolName   MCP tool name (e.g., "kg_food_to_bioactives")
 * @param args       Tool arguments
 */
export function callKgTool(
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<KgToolResult> {
  // label "kg-mcp" preserves the original messages ("kg-mcp returned …",
  // "kg-mcp call failed: …", "kg-mcp tool error").
  return callMcpTool(baseUrl, authToken, toolName, args, { label: "kg-mcp" });
}
