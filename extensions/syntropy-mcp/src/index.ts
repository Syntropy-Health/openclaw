/**
 * Syntropy MCP — dynamic tool surface for openclaw.
 *
 * Discovers tools from configured MCP servers via the {@link ToolCatalog}
 * (T1.2) and registers them into the agent loop as executable tools. The
 * plugin owns scheduling (the catalog never self-timers): register() primes
 * discovery fire-and-forget with capped-backoff retries, and a periodic
 * interval re-refreshes servers whose cache is due (`needsRefresh`).
 * `gateway_stop` clears every timer.
 *
 * Auth is per-server and fail-closed:
 * - `static-key` — the token is read from `process.env[apiKeyEnv]` once per
 *   token request. A missing/empty env at register time excludes the server
 *   from the catalog entirely (zero tools, ONE structured log, no throw);
 *   other servers are unaffected.
 * - `m2m-exchange` — the TokenExchangeClient is a later task (B2). Until
 *   then these servers register with a `getToken` that ALWAYS rejects
 *   (`exchange-not-implemented (B2)`): fail-closed, zero tools, one
 *   structured plugin log. Not faked.
 *
 * Priority ordering (mirrors extensions/syntropy):
 *   35  syntropy (identity gate + profile injection)
 *   30  syntropy-mcp (THIS — discovered-tool context line)
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TObject, type TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  callMcpTool,
  listMcpTools,
  McpSession,
  type McpToolListResult,
  type McpToolResult,
} from "../../syntropy/src/client.js";
import {
  ToolCatalog,
  type CatalogEntry,
  type ListToolsFn,
  type McpServerConfig,
} from "./catalog.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type SyntropyMcpServerSpec = {
  id: string;
  baseUrl: string;
  auth: "static-key" | "m2m-exchange";
  /** static-key: env var holding the Bearer token (read per token request). */
  apiKeyEnv?: string;
  /** m2m-exchange: canonical resource URI for the exchanged token (B2). */
  resource?: string;
  /** m2m-exchange: token-exchange endpoint path (B2). */
  exchangePath?: string;
  /** Error-message label; defaults to `id`. */
  label?: string;
};

export type SyntropyMcpConfig = {
  servers: SyntropyMcpServerSpec[];
  refreshSeconds: number;
  maxStaleSeconds: number;
};

const DEFAULT_REFRESH_SECONDS = 300;

function parseServer(raw: unknown, index: number): SyntropyMcpServerSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`servers[${index}] must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const { id, baseUrl, auth, apiKeyEnv, resource, exchangePath, label } = entry;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`servers[${index}].id must be a non-empty string`);
  }
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    throw new Error(`servers[${index}] ("${id}") requires a baseUrl string`);
  }
  if (auth !== "static-key" && auth !== "m2m-exchange") {
    throw new Error(`servers[${index}] ("${id}") auth must be "static-key" or "m2m-exchange"`);
  }
  if (auth === "static-key" && (typeof apiKeyEnv !== "string" || !apiKeyEnv.trim())) {
    throw new Error(`servers[${index}] ("${id}") auth=static-key requires apiKeyEnv`);
  }
  if (auth === "m2m-exchange" && (typeof resource !== "string" || !resource.trim())) {
    throw new Error(`servers[${index}] ("${id}") auth=m2m-exchange requires resource`);
  }
  const spec: SyntropyMcpServerSpec = { id: id.trim(), baseUrl: baseUrl.trim(), auth };
  if (typeof apiKeyEnv === "string") spec.apiKeyEnv = apiKeyEnv.trim();
  if (typeof resource === "string") spec.resource = resource.trim();
  if (typeof exchangePath === "string") spec.exchangePath = exchangePath.trim();
  if (typeof label === "string" && label.trim()) spec.label = label.trim();
  return spec;
}

/**
 * Parse + validate the plugin config. Throws on malformed input (register()
 * catches and disables the plugin — fail-fast, mirroring extensions/syntropy).
 * An absent/empty `servers` array parses fine and means "plugin inert".
 */
export function parseSyntropyMcpConfig(
  raw: Record<string, unknown> | undefined,
): SyntropyMcpConfig {
  const serversRaw = raw?.servers;
  if (serversRaw !== undefined && !Array.isArray(serversRaw)) {
    throw new Error("servers must be an array");
  }
  const servers = (serversRaw ?? []).map((entry, index) => parseServer(entry, index));
  const seen = new Set<string>();
  for (const server of servers) {
    if (seen.has(server.id)) throw new Error(`duplicate server id "${server.id}"`);
    seen.add(server.id);
  }

  const refreshSecondsRaw = raw?.refreshSeconds;
  if (refreshSecondsRaw !== undefined && typeof refreshSecondsRaw !== "number") {
    throw new Error("refreshSeconds must be a number");
  }
  const refreshSeconds =
    typeof refreshSecondsRaw === "number" && refreshSecondsRaw > 0
      ? refreshSecondsRaw
      : DEFAULT_REFRESH_SECONDS;

  const maxStaleSecondsRaw = raw?.maxStaleSeconds;
  if (maxStaleSecondsRaw !== undefined && typeof maxStaleSecondsRaw !== "number") {
    throw new Error("maxStaleSeconds must be a number");
  }
  const maxStaleSeconds =
    typeof maxStaleSecondsRaw === "number" && maxStaleSecondsRaw > 0
      ? maxStaleSecondsRaw
      : 3 * refreshSeconds;

  return { servers, refreshSeconds, maxStaleSeconds };
}

// ---------------------------------------------------------------------------
// Injectable seams (tests mock transport + timers; production uses defaults)
// ---------------------------------------------------------------------------

/** Executable-transport signature — matches {@link callMcpTool}. */
export type CallToolFn = (
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { label: string; session?: McpSession },
) => Promise<McpToolResult>;

/**
 * Discovery-transport signature incl. the optional session — matches
 * {@link listMcpTools}. Narrower `{ label }`-only fns remain assignable.
 */
export type ListToolsWithSessionFn = (
  baseUrl: string,
  authToken: string,
  opts: { label: string; session?: McpSession },
) => Promise<McpToolListResult>;

export type SyntropyMcpOverrides = {
  listTools?: ListToolsWithSessionFn;
  callTool?: CallToolFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

// ---------------------------------------------------------------------------
// Descriptor → agent tool mapping
// ---------------------------------------------------------------------------

/**
 * Derive a permissive TypeBox parameters object from an MCP `inputSchema`.
 * Top-level `object`/`properties` pass through as `Type.Any` fields (with
 * descriptions and required-ness preserved); anything absent or unparseable
 * falls back to a fully permissive passthrough object. Deliberately NOT a
 * JSON-schema→TypeBox converter.
 */
function toParameters(inputSchema?: Record<string, unknown>): TObject {
  const permissive = () => Type.Object({}, { additionalProperties: true });
  if (!inputSchema || inputSchema.type !== "object") return permissive();
  const props = inputSchema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return permissive();
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((k): k is string => typeof k === "string")
    : [];
  const shape: Record<string, TSchema> = {};
  for (const [key, rawProp] of Object.entries(props as Record<string, unknown>)) {
    const description =
      rawProp && typeof rawProp === "object"
        ? (rawProp as Record<string, unknown>).description
        : undefined;
    const field = Type.Any(typeof description === "string" ? { description } : {});
    shape[key] = required.includes(key) ? field : Type.Optional(field);
  }
  return Type.Object(shape, { additionalProperties: true });
}

/** Map an {@link McpToolResult} to the agent-loop result shape (kg-tools pattern). */
function toAgentResult(res: McpToolResult): AgentToolResult<unknown> {
  if (!res.ok) {
    return {
      content: [{ type: "text", text: `Error: ${res.error ?? "Unknown error"}` }],
      details: { error: res.error },
    };
  }
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
  return { content: [{ type: "text", text }], details: res.data };
}

/** Server-side "no such tool" shapes that warrant one refresh-and-retry. */
function isUnknownToolError(error: string | undefined): boolean {
  if (!error) return false;
  return /unknown tool|tool not found|method not found/i.test(error);
}

type ServerRuntime = {
  id: string;
  baseUrl: string;
  label: string;
  getToken: () => Promise<string>;
  /** ONE lazily-established MCP session per configured server (T1.4). */
  session: McpSession;
};

function buildAgentTool(params: {
  entry: CatalogEntry;
  server: ServerRuntime;
  catalog: ToolCatalog;
  callTool: CallToolFn;
}) {
  const { entry, server, catalog, callTool } = params;
  const surfacedName = entry.descriptor.name;
  // The catalog prefixes colliding names with "<serverId>:"; the wire name
  // the MCP server knows is the unprefixed one.
  const wireName = surfacedName.startsWith(`${server.id}:`)
    ? surfacedName.slice(server.id.length + 1)
    : surfacedName;

  return {
    name: surfacedName,
    label: surfacedName,
    description: entry.descriptor.description ?? `${server.label} MCP tool "${wireName}"`,
    parameters: toParameters(entry.descriptor.inputSchema),
    async execute(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
      const toolArgs = (args ?? {}) as Record<string, unknown>;
      const callOnce = async (): Promise<McpToolResult> => {
        let token: string;
        try {
          // Fail-closed: never emit an unauthenticated call; the token value
          // is never interpolated into results — only the provider's message.
          token = await server.getToken();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { data: null, ok: false, error: `${server.label} auth failed: ${msg}` };
        }
        return callTool(server.baseUrl, token, wireName, toolArgs, {
          label: server.label,
          session: server.session,
        });
      };

      let result = await callOnce();
      if (!result.ok && isUnknownToolError(result.error)) {
        // Server-side drift: our cached descriptor no longer exists there.
        // Re-discover this server, then retry the call exactly once.
        await catalog.refresh(server.id);
        result = await callOnce();
      }
      return toAgentResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const MAX_PRIME_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export function createSyntropyMcpPlugin(overrides: SyntropyMcpOverrides = {}) {
  return {
    id: "syntropy-mcp",
    name: "Syntropy MCP Tools",
    description:
      "Dynamic MCP tool surface — discovers tools from configured MCP servers " +
      "and registers them into the agent loop.",

    register(api: OpenClawPluginApi) {
      const env = overrides.env ?? process.env;
      const callTool = overrides.callTool ?? callMcpTool;
      const setIntervalFn = overrides.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
      const clearIntervalFn =
        overrides.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
      const setTimeoutFn = overrides.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
      const clearTimeoutFn =
        overrides.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));

      let config: SyntropyMcpConfig;
      try {
        config = parseSyntropyMcpConfig(api.pluginConfig as Record<string, unknown> | undefined);
      } catch (err) {
        api.logger.error(
          `syntropy-mcp: invalid config — ${err instanceof Error ? err.message : String(err)} — plugin disabled`,
        );
        return;
      }

      if (config.servers.length === 0) {
        // Disabled-unless-configured gate: without servers there is nothing
        // to discover — register no tools, hooks, or timers.
        api.logger.info("syntropy-mcp: no servers configured — plugin inert");
        return;
      }

      // ------------------------------------------------------------------
      // Per-server auth seams (fail-closed)
      // ------------------------------------------------------------------

      const runtimes = new Map<string, ServerRuntime>();
      const catalogServers: McpServerConfig[] = [];
      // ONE McpSession per configured server, threaded through BOTH discovery
      // (catalog listTools, looked up by baseUrl — the only key the catalog
      // hands the transport) and tool execute (see buildAgentTool).
      const sessionsByBaseUrl = new Map<string, McpSession>();

      for (const spec of config.servers) {
        const label = spec.label ?? spec.id;
        const session = new McpSession(spec.baseUrl);
        if (spec.auth === "static-key") {
          const apiKeyEnv = spec.apiKeyEnv as string; // validated by the parser
          const registerTimeValue = env[apiKeyEnv];
          if (!registerTimeValue || !registerTimeValue.trim()) {
            // Fail-closed: the server contributes NO catalog server. Exactly
            // ONE structured log line; never the token value; no throw.
            api.logger.error(
              `syntropy-mcp: server "${spec.id}" disabled — env ${apiKeyEnv} missing/empty (fail-closed, zero tools)`,
            );
            continue;
          }
          const getToken = async (): Promise<string> => {
            // Read once per token request so rotations are picked up.
            const value = env[apiKeyEnv];
            if (!value || !value.trim()) {
              throw new Error(`env ${apiKeyEnv} missing/empty`);
            }
            return value;
          };
          runtimes.set(spec.id, { id: spec.id, baseUrl: spec.baseUrl, label, getToken, session });
          catalogServers.push({ id: spec.id, baseUrl: spec.baseUrl, label, getToken });
          sessionsByBaseUrl.set(spec.baseUrl, session);
          continue;
        }

        // m2m-exchange — TokenExchangeClient lands in B2. Until then this
        // server is registered fail-closed: getToken ALWAYS rejects, so the
        // catalog records an auth failure and serves zero tools. Not faked.
        api.logger.warn(
          `syntropy-mcp: server "${spec.id}" (m2m-exchange) fail-closed — token exchange not implemented (B2); zero tools until the exchange client lands`,
        );
        const getToken = (): Promise<string> =>
          Promise.reject(new Error("exchange-not-implemented (B2)"));
        runtimes.set(spec.id, { id: spec.id, baseUrl: spec.baseUrl, label, getToken, session });
        catalogServers.push({ id: spec.id, baseUrl: spec.baseUrl, label, getToken });
        sessionsByBaseUrl.set(spec.baseUrl, session);
      }

      // The catalog's ListToolsFn signature stays `{ label }`-only; the plugin
      // wraps the transport so each server's session rides along by baseUrl.
      const baseListTools: ListToolsWithSessionFn = overrides.listTools ?? listMcpTools;
      const listToolsWithSession: ListToolsFn = (listBaseUrl, token, listOpts) =>
        baseListTools(listBaseUrl, token, {
          ...listOpts,
          session: sessionsByBaseUrl.get(listBaseUrl),
        });

      const catalog = new ToolCatalog(catalogServers, {
        refreshSeconds: config.refreshSeconds,
        maxStaleSeconds: config.maxStaleSeconds,
        now: overrides.now,
        listTools: listToolsWithSession,
        log: api.logger,
      });
      const serverIds = catalogServers.map((server) => server.id);

      api.logger.info(
        `syntropy-mcp: enabled (servers=${serverIds.join(",") || "none"}, refresh=${config.refreshSeconds}s)`,
      );

      // ------------------------------------------------------------------
      // Discovery priming — fire-and-forget with capped backoff (max 3)
      // ------------------------------------------------------------------

      const pendingBackoff = new Set<unknown>();
      let stopped = false;

      const unfetchedIds = () => serverIds.filter((id) => catalog.lastState(id).fetchedAt === null);

      const primeAttempt = (attempt: number): void => {
        const targets = attempt === 1 ? serverIds : unfetchedIds();
        void Promise.all(targets.map((id) => catalog.refresh(id)))
          .then(() => {
            if (stopped) return;
            const remaining = unfetchedIds();
            if (remaining.length === 0 || attempt >= MAX_PRIME_ATTEMPTS) return;
            const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
            const handle = setTimeoutFn(() => {
              pendingBackoff.delete(handle);
              primeAttempt(attempt + 1);
            }, delayMs);
            pendingBackoff.add(handle);
          })
          .catch((err) => {
            // catalog.refresh never rejects; this is a pure belt-and-braces.
            api.logger.error(`syntropy-mcp: discovery prime error: ${err}`);
          });
      };
      primeAttempt(1); // register() itself never awaits the network

      // ------------------------------------------------------------------
      // Periodic refresh — the PLUGIN owns scheduling (catalog never does)
      // ------------------------------------------------------------------

      const intervalHandle = setIntervalFn(() => {
        for (const id of serverIds) {
          if (catalog.needsRefresh(id)) void catalog.refresh(id);
        }
      }, config.refreshSeconds * 1000);

      // ------------------------------------------------------------------
      // Tool factory (SYNC) — snapshot of the catalog at agent start
      // ------------------------------------------------------------------

      api.registerTool(() => {
        try {
          const entries = catalog.getToolDescriptors();
          if (entries.length === 0) return null;
          const tools = [];
          for (const entry of entries) {
            const server = runtimes.get(entry.serverId);
            if (!server) continue; // defensive: catalog only knows registered servers
            tools.push(buildAgentTool({ entry, server, catalog, callTool }));
          }
          return tools.length > 0 ? tools : null;
        } catch (err) {
          api.logger.error(`syntropy-mcp: tool factory error: ${err}`);
          return null;
        }
      });

      // ------------------------------------------------------------------
      // Hook: before_agent_start (priority 30 — just below syntropy's 35)
      // ------------------------------------------------------------------

      api.on(
        "before_agent_start",
        async () => {
          try {
            const names = catalog.getToolDescriptors().map((entry) => entry.descriptor.name);
            if (names.length === 0) return {};
            return {
              prependContext: `[SYNTROPY_MCP] Discovered MCP tools available: ${names.join(", ")}`,
            };
          } catch (err) {
            api.logger.error(`syntropy-mcp: before_agent_start error: ${err}`);
            return {};
          }
        },
        { priority: 30 },
      );

      // ------------------------------------------------------------------
      // Shutdown — clear every timer; no dangling handles
      // ------------------------------------------------------------------

      api.on(
        "gateway_stop",
        async () => {
          stopped = true;
          clearIntervalFn(intervalHandle);
          for (const handle of pendingBackoff) clearTimeoutFn(handle);
          pendingBackoff.clear();
          api.logger.info("syntropy-mcp: timers cleared");
        },
        { priority: 90 },
      );
    },
  };
}

const syntropyMcpPlugin = createSyntropyMcpPlugin();

export default syntropyMcpPlugin;
