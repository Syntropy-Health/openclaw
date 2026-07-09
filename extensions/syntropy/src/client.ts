/**
 * HTTP client for calling MCP tools via Streamable HTTP transport.
 *
 * `callMcpTool` is the shared JSON-RPC-over-HTTP transport used for both the
 * Syntropy Journals MCP (`callSyntropyTool`) and the kg-mcp server
 * (`callKgTool`, in `kg-client.ts`). Both use the same `sj_*` Bearer token
 * (ADR-001 §2 — one token type for server-to-server traffic), the same
 * JSON-RPC envelope, and the same MCP content-array unwrapping; they differ
 * only in the error-message label.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolResult {
  data: unknown;
  ok: boolean;
  error?: string;
}

/** Result of a Syntropy Journals MCP tool call. Alias of {@link McpToolResult}. */
export type SyntropyToolResult = McpToolResult;

/** One tool entry from an MCP `tools/list` response. */
export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

/** Result of an MCP `tools/list` discovery call. */
export type McpToolListResult =
  | { ok: true; tools: McpToolDescriptor[] }
  | { ok: false; error: string };

/** Shared request timeout for all MCP transport calls. */
const MCP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Shared client
// ---------------------------------------------------------------------------

/**
 * Call an MCP tool over JSON-RPC/HTTP on behalf of a verified user.
 *
 * Per ADR-001 §5, kg-mcp tool handlers return structured paywall responses
 * (not HTTP errors) when the user's τ-balance is insufficient — those shapes
 * pass through unchanged so the agent's standard tool-result rendering surfaces
 * them.
 *
 * @param baseUrl    MCP base URL (e.g., "http://localhost:3000")
 * @param authToken  The user's stored `sj_<short>_<long>` API token (Bearer)
 * @param toolName   MCP tool name (e.g., "log_food")
 * @param args       Tool arguments
 * @param opts.label          Error-message label (e.g. "Syntropy", "kg-mcp") —
 *                            used for `<label> returned …` and `<label> call failed: …`.
 * @param opts.toolErrorLabel Label for the JSON-RPC error envelope default
 *                            (`<toolErrorLabel> tool error`). Defaults to `label`.
 */
export async function callMcpTool(
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { label: string; toolErrorLabel?: string },
): Promise<McpToolResult> {
  const { label } = opts;
  const toolErrorLabel = opts.toolErrorLabel ?? label;
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
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { data: null, ok: false, error: `${label} returned ${resp.status}: ${text}` };
    }

    const json = (await resp.json()) as Record<string, unknown>;

    // JSON-RPC error envelope
    if (json.error && typeof json.error === "object") {
      const err = json.error as { message?: string };
      return { data: null, ok: false, error: err.message ?? `${toolErrorLabel} tool error` };
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

    return { data: result, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, ok: false, error: `${label} call failed: ${msg}` };
  }
}

/**
 * Discover the tools an MCP server exposes via JSON-RPC `tools/list`.
 *
 * Uses the same Streamable-HTTP transport as {@link callMcpTool}: POST
 * `${baseUrl}/mcp`, Bearer auth, shared timeout, JSON-RPC envelope. Entries
 * missing a string `name` are skipped (not fatal). Never throws — all failures
 * come back as `{ ok: false, error }`, and the auth token is never included
 * in error strings.
 *
 * @param baseUrl    MCP base URL (e.g., "http://localhost:3000")
 * @param authToken  Bearer token (e.g., `sj_*` API token)
 * @param opts.label Error-message label (e.g. "Syntropy", "kg-mcp")
 */
export async function listMcpTools(
  baseUrl: string,
  authToken: string,
  opts: { label: string },
): Promise<McpToolListResult> {
  const { label } = opts;

  try {
    const resp = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });

    if (!resp.ok) {
      return { ok: false, error: `${label} tools/list HTTP ${resp.status}` };
    }

    const json = (await resp.json()) as Record<string, unknown>;

    // JSON-RPC error envelope
    if (json.error && typeof json.error === "object") {
      const message = (json.error as { message?: string }).message ?? "unknown error";
      return { ok: false, error: `${label} tools/list error: ${message}` };
    }

    const result = json.result as Record<string, unknown> | undefined;
    const rawTools = result?.tools;
    if (!Array.isArray(rawTools)) {
      return { ok: false, error: `${label} tools/list returned no tools array` };
    }

    const tools: McpToolDescriptor[] = [];
    for (const entry of rawTools) {
      if (!entry || typeof entry !== "object") continue;
      const { name, description, inputSchema, annotations } = entry as {
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
        annotations?: unknown;
      };
      if (typeof name !== "string") continue; // skip nameless entries, not fatal
      const tool: McpToolDescriptor = { name };
      if (typeof description === "string") tool.description = description;
      if (inputSchema && typeof inputSchema === "object") {
        tool.inputSchema = inputSchema as Record<string, unknown>;
      }
      if (annotations && typeof annotations === "object") {
        tool.annotations = annotations as Record<string, unknown>;
      }
      tools.push(tool);
    }

    return { ok: true, tools };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${label} tools/list failed: ${msg}` };
  }
}

/**
 * Call an MCP tool authenticated with the **service-auth (M2M)** Bearer instead
 * of a per-user `sj_*` token — the openclaw → SJ `/mcp` machine path (P2 wire
 * contract). The Bearer is a Clerk M2M JWT carrying the `resource` claim, minted
 * + cached + refreshed by `ServiceAuthProvider` (see `service-auth.ts`).
 *
 * This is the documented seam where openclaw's eventual MCP-tool consumption of
 * SJ `/mcp` (and the P1 matrix client) attaches machine auth: it resolves the
 * token from the provider (fail-closed if the machine secret is missing) and
 * then reuses the exact same {@link callMcpTool} transport — `callMcpTool` treats
 * the token as an opaque Bearer, so no transport change is needed.
 *
 * The provider is passed by its minimal `getToken` surface so this module does
 * not depend on the provider class (and tests can inject a stub).
 *
 * Like {@link callMcpTool}, `label` is **required** — each caller (SJ `/mcp`,
 * kg-mcp, …) names itself so error messages aren't mislabeled. There is no
 * default label here; a thin per-target wrapper supplies it.
 *
 * @param baseUrl   SJ base URL whose `/mcp` is the target (e.g. "https://shrine-api-test…").
 * @param provider  Anything exposing `getToken(): Promise<string>` — typically a
 *                  `ServiceAuthProvider`. Throws (fail-closed) when no secret.
 * @param toolName  MCP tool name.
 * @param args      Tool arguments.
 * @param opts.label          Error-message label (e.g. "Syntropy", "kg-mcp").
 * @param opts.toolErrorLabel JSON-RPC error-envelope label. Defaults to `label`.
 */
export async function callMcpToolWithServiceAuth(
  baseUrl: string,
  provider: { getToken(): Promise<string> },
  toolName: string,
  args: Record<string, unknown>,
  opts: { label: string; toolErrorLabel?: string },
): Promise<McpToolResult> {
  const { label } = opts;
  const toolErrorLabel = opts.toolErrorLabel ?? label;
  let token: string;
  try {
    // Fail-closed: surface the missing-secret / mint error as a tool result
    // rather than emitting an unauthenticated request.
    token = await provider.getToken();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, ok: false, error: `${label} service-auth failed: ${msg}` };
  }
  return callMcpTool(baseUrl, token, toolName, args, { label, toolErrorLabel });
}

/**
 * Call a Syntropy MCP tool on behalf of a verified user.
 *
 * @param baseUrl    Syntropy base URL (e.g., "http://localhost:3000")
 * @param authToken  The stored `sj_<short>_<long>` API token
 * @param toolName   MCP tool name (e.g., "log_food")
 * @param args       Tool arguments
 */
export function callSyntropyTool(
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<SyntropyToolResult> {
  // label "Syntropy" + toolErrorLabel "MCP" preserves the original messages
  // ("Syntropy returned …", "Syntropy call failed: …", "MCP tool error").
  return callMcpTool(baseUrl, authToken, toolName, args, {
    label: "Syntropy",
    toolErrorLabel: "MCP",
  });
}
