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

/**
 * MCP Streamable-HTTP requires clients to accept BOTH JSON and SSE responses;
 * FastMCP servers reply 406 Not Acceptable without this exact pair.
 */
const MCP_ACCEPT = "application/json, text/event-stream";

/**
 * Parse an MCP Streamable-HTTP response body into the JSON-RPC message.
 *
 * A streamable-http server may reply either with plain JSON or with SSE
 * framing (`Content-Type: text/event-stream`, lines `event: message` /
 * `data: {json}` / blank). For SSE, the JSON-RPC response message is the
 * LAST `data:` line. Throws on malformed bodies (no `data:` line, invalid
 * JSON) — callers convert that into their structured error result.
 */
async function parseMcpResponse(resp: Response): Promise<Record<string, unknown>> {
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return (await resp.json()) as Record<string, unknown>;
  }
  const text = await resp.text();
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  const last = dataLines[dataLines.length - 1];
  if (last === undefined) {
    throw new Error("SSE response contained no data line");
  }
  return JSON.parse(last.slice("data:".length).trim()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Session (MCP streamable-http STATEFUL servers)
// ---------------------------------------------------------------------------

/**
 * Lazily-established MCP streamable-http session for STATEFUL servers (e.g.
 * FastMCP kg-mcp, which rejects bare JSON-RPC calls with 400 "Missing session
 * ID"). Per the MCP streamable-http spec the flow is: (1) POST `initialize`
 * with NO session header — the response carries an `mcp-session-id` header;
 * (2) send the `notifications/initialized` notification with that header
 * (best-effort, fire-and-forget); (3) attach the header to every subsequent
 * request.
 *
 * `ensure` is single-flighted and caches the outcome: a string session id for
 * stateful servers, or `null` when the server returned NO `mcp-session-id`
 * header (stateless server — no session needed; e.g. SJ's `stateless_http`
 * `/mcp`). A failed initialize is NOT cached — it rejects, and the calling
 * transport function's try/catch surfaces it as its structured error (nothing
 * throws past `callMcpTool`/`listMcpTools`). `invalidate()` clears the cache
 * for expired-session recovery. Error messages never include the auth token
 * or the session id.
 */
export class McpSession {
  private readonly baseUrl: string;
  private readonly clientName: string;
  /** `undefined` = not established; `null` = stateless server (no session). */
  private cached: string | null | undefined;
  private inFlight: Promise<string | null> | null = null;

  constructor(baseUrl: string, opts?: { clientName?: string }) {
    this.baseUrl = baseUrl;
    this.clientName = opts?.clientName ?? "openclaw-syntropy-mcp";
  }

  /**
   * Resolve the session id to attach (or `null` for a stateless server),
   * performing the initialize handshake on first use. Single-flighted;
   * rejects on initialize failure (caller catches → structured error).
   */
  ensure(authToken: string): Promise<string | null> {
    if (this.cached !== undefined) return Promise.resolve(this.cached);
    if (this.inFlight) return this.inFlight;
    const flight = this.initialize(authToken)
      .then((sessionId) => {
        this.cached = sessionId;
        return sessionId;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = flight;
    return flight;
  }

  /** Forget the cached session (expired-session recovery re-initializes). */
  invalidate(): void {
    this.cached = undefined;
  }

  private async initialize(authToken: string): Promise<string | null> {
    const resp = await fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: this.clientName, version: "1.0" },
        },
        id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`MCP initialize failed: HTTP ${resp.status}`);
    }

    // The initialize response may itself be SSE-framed.
    const json = await parseMcpResponse(resp);
    if (json.error && typeof json.error === "object") {
      const message = (json.error as { message?: string }).message ?? "unknown error";
      throw new Error(`MCP initialize error: ${message}`);
    }

    const sessionId = resp.headers.get("mcp-session-id");
    if (sessionId === null) return null; // stateless server — no session needed

    // notifications/initialized — best-effort, fire-and-forget (no id).
    void fetch(`${this.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: MCP_ACCEPT,
        Authorization: `Bearer ${authToken}`,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    }).catch(() => {
      // Best-effort only — a lost notification never fails the call.
    });

    return sessionId;
  }
}

/**
 * POST one JSON-RPC request over MCP streamable-http, optionally under an
 * {@link McpSession}. Without a session this is byte-identical to the bare
 * transport (the stateless SJ path). With one, the session is established
 * lazily and its id attached as `mcp-session-id`; an HTTP 400/404 while a
 * session header was attached is treated as an expired session — invalidate,
 * re-`ensure`, retry EXACTLY once. `session.ensure` rejections propagate to
 * the caller's try/catch (structured error).
 */
async function postMcpRequest(
  url: string,
  authToken: string,
  body: string,
  session?: McpSession,
): Promise<Response> {
  const doFetch = (sessionId: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      Authorization: `Bearer ${authToken}`,
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    return fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
  };

  if (!session) return doFetch(null);

  let sessionId = await session.ensure(authToken);
  let resp = await doFetch(sessionId);
  if (sessionId !== null && (resp.status === 400 || resp.status === 404)) {
    // Expired-session recovery: only when a session header was attached.
    session.invalidate();
    sessionId = await session.ensure(authToken);
    resp = await doFetch(sessionId);
  }
  return resp;
}

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
 * @param opts.session        Optional {@link McpSession} for STATEFUL
 *                            streamable-http servers. Absent → bare transport,
 *                            byte-identical to before (the SJ path).
 */
export async function callMcpTool(
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { label: string; toolErrorLabel?: string; session?: McpSession },
): Promise<McpToolResult> {
  const { label } = opts;
  const toolErrorLabel = opts.toolErrorLabel ?? label;
  const url = `${baseUrl}/mcp`;

  try {
    const resp = await postMcpRequest(
      url,
      authToken,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: crypto.randomUUID(),
      }),
      opts.session,
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { data: null, ok: false, error: `${label} returned ${resp.status}: ${text}` };
    }

    const json = await parseMcpResponse(resp);

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
 * @param baseUrl      MCP base URL (e.g., "http://localhost:3000")
 * @param authToken    Bearer token (e.g., `sj_*` API token)
 * @param opts.label   Error-message label (e.g. "Syntropy", "kg-mcp")
 * @param opts.session Optional {@link McpSession} for STATEFUL streamable-http
 *                     servers. Absent → bare transport, byte-identical to
 *                     before (the SJ path).
 */
export async function listMcpTools(
  baseUrl: string,
  authToken: string,
  opts: { label: string; session?: McpSession },
): Promise<McpToolListResult> {
  const { label } = opts;

  try {
    const resp = await postMcpRequest(
      `${baseUrl}/mcp`,
      authToken,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
        id: crypto.randomUUID(),
      }),
      opts.session,
    );

    if (!resp.ok) {
      return { ok: false, error: `${label} tools/list HTTP ${resp.status}` };
    }

    const json = await parseMcpResponse(resp);

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
