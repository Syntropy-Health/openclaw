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
 * - `m2m-exchange` — discovery uses the M2M actor token
 *   ({@link ServiceAuthProvider}, `CLERK_MACHINE_SECRET_KEY`); per-user tool
 *   execution uses a short-lived RFC-8693 exchanged token via
 *   {@link TokenExchangeClient} (Tier-1 user JWT / Tier-2 `<channel>:<externalId>`),
 *   RS256-JWKS-validated before use. Fail-closed: an incomplete config (absent
 *   machine secret / issuer / resource) disables the server (zero tools, one
 *   structured log), and execution with no verified user identity rejects —
 *   never a faked or M2M-as-user fallback.
 *
 * Priority ordering (mirrors extensions/syntropy):
 *   35  syntropy (identity gate + profile injection)
 *   30  syntropy-mcp (THIS — discovered-tool context line)
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TObject, type TSchema } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { TtlCache } from "../../syntropy/src/cache.js";
import {
  callMcpTool,
  listMcpTools,
  McpSession,
  type McpToolListResult,
  type McpToolResult,
} from "../../syntropy/src/client.js";
import {
  resolveServiceAuthConfig,
  ServiceAuthConfigError,
} from "../../syntropy/src/service-auth-config.js";
import { ServiceAuthProvider } from "../../syntropy/src/service-auth.js";
import {
  ToolCatalog,
  type CatalogEntry,
  type ListToolsFn,
  type McpServerConfig,
} from "./catalog.js";
import { ConfirmGovernor } from "./governor.js";
import { PendingConfirmStore } from "./pending-confirm-store.js";
import {
  subjectId,
  TokenExchangeClient,
  type ExchangeSubject,
  type VerifyMintedTokenFn,
} from "./token-exchange.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type SyntropyMcpServerSpec = {
  id: string;
  baseUrl: string;
  auth: "static-key" | "m2m-exchange";
  /** static-key: env var holding the Bearer token (read per token request). */
  apiKeyEnv?: string;
  /** m2m-exchange: canonical resource URI for the exchanged token (B2) == expected `aud`. */
  resource?: string;
  /** m2m-exchange: token-exchange endpoint path (B2). Default "/api/tokens/exchange". */
  exchangePath?: string;
  /** m2m-exchange: JWKS path for verifying the SJ-minted token. Default "/api/mcp/.well-known/jwks.json". */
  jwksPath?: string;
  /**
   * m2m-exchange: the gateway machine `sub` expected as `act.sub` on the minted
   * token (Option B binding check). Falls back to env `SYNTROPY_MCP_MACHINE_SUB`.
   */
  machineSub?: string;
  /**
   * m2m-exchange: expected `iss` on the minted token (SJ base / issuer URL).
   * Falls back to env `SYNTROPY_MCP_TOKEN_ISS`; fail-closed if unresolvable.
   */
  issuer?: string;
  /**
   * Allowlist of this server's mutating commit-tool names (B1/B4). ONLY a tool
   * named here can be gated by the Confirm Governor — a descriptor whose
   * `ui.commit_tool` is not in this set renders summary-only, and a commit call
   * to a tool not in ANY server's allowlist is never gated (nor blocked) here.
   */
  commitTools?: string[];
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
  const {
    id,
    baseUrl,
    auth,
    apiKeyEnv,
    resource,
    exchangePath,
    jwksPath,
    machineSub,
    issuer,
    commitTools,
    label,
  } = entry;
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
  if (typeof jwksPath === "string") spec.jwksPath = jwksPath.trim();
  if (typeof machineSub === "string" && machineSub.trim()) spec.machineSub = machineSub.trim();
  if (typeof issuer === "string" && issuer.trim()) spec.issuer = issuer.trim();
  if (commitTools !== undefined) {
    if (!Array.isArray(commitTools) || !commitTools.every((t) => typeof t === "string")) {
      throw new Error(`servers[${index}] ("${id}") commitTools must be an array of strings`);
    }
    const names = commitTools.map((t) => (t as string).trim()).filter((t) => t.length > 0);
    if (names.length > 0) spec.commitTools = names;
  }
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

  // PR#56 review: maxStaleSeconds < refreshSeconds is incoherent — a tool could be
  // both "fresh" (age <= refresh) and "past max-stale" (age > maxStale), making the
  // fail-closed drop fire on still-fresh tools. Reject at config time.
  if (maxStaleSeconds < refreshSeconds) {
    throw new Error("maxStaleSeconds must be >= refreshSeconds");
  }

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
  /** B4: inject a pre-built pending store (tests); default real. */
  pendingStore?: PendingConfirmStore;
  /** B4: inject a pre-built governor (tests); default real over pendingStore. */
  governor?: ConfirmGovernor;
  /** B4: injectable pending-id source for the default store (tests). */
  mintId?: () => string;
  /**
   * B2: inject the M2M actor-token provider used as the `actor_token` for the
   * token exchange (tests). Applied to ALL m2m-exchange servers. Default: one
   * {@link ServiceAuthProvider} per m2m server, built from the server's
   * `resource` + env (`CLERK_MACHINE_SECRET_KEY`).
   */
  serviceAuthProvider?: ActorTokenProvider | null;
  /** B2: injectable transport for the token-exchange POST (tests). Default `fetch`. */
  exchangeFetch?: typeof fetch;
  /** B2: injectable JWKS verify seam for the SJ-minted token (tests). */
  verifyMintedToken?: VerifyMintedTokenFn;
};

/** The subset of {@link ServiceAuthProvider} the exchange wiring needs. */
export type ActorTokenProvider = {
  getToken(): Promise<string>;
  readonly secretMissing: boolean;
};

/**
 * Per-request identity the m2m execute-time getToken resolves against.
 * `channel` is required for the Tier-2 channel-scoped requested_subject
 * ("<channel>:<externalId>"); `userJwt` selects Tier 1 (Clerk-JWT/HTTP).
 *
 * BOUNDARY: this is the LOOSE inbound shape (all-optional). `ExchangeSubject`
 * (token-exchange.ts) is the VALIDATED discriminated-union form the exchange
 * requires; `toExchangeSubject` (below) is the ONLY bridge — it validates/narrows
 * a RequestSubject into an ExchangeSubject (or null). Never pass a RequestSubject
 * to the exchange directly.
 */
export type RequestSubject = { externalId?: string; userJwt?: string; channel?: string };

/**
 * Read a live user Clerk JWT off the agent hook context (Tier-1 seam), or
 * undefined. The current `PluginHookAgentContext` exposes only `externalId` (the
 * host forwards the verified `sub`, not the JWT), so Tier 1 stays dormant — this
 * typed accessor is the single seam that lights it up if/when the host surfaces
 * a `userJwt`, replacing an untyped inline cast. Accepts `unknown` because the
 * field is not (yet) on the published context type.
 */
function readUserJwt(ctx: unknown): string | undefined {
  const raw = ctx && typeof ctx === "object" ? (ctx as { userJwt?: unknown }).userJwt : undefined;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

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
  /**
   * Resolve the Bearer for a TOOL CALL. static-key ignores `subject` (env
   * token); m2m-exchange requires `subject.externalId` and returns a per-user
   * exchanged token (fail-closed with no identity).
   */
  getToken: (subject?: RequestSubject) => Promise<string>;
  /** m2m-exchange only: drop this subject's cached exchanged token after a 401. */
  invalidateUserToken?: (subject: RequestSubject) => void;
  /** ONE lazily-established MCP session per configured server (T1.4). */
  session: McpSession;
};

/** Server-side "expired/invalid credential" shapes that warrant a re-exchange. */
export function isUnauthorizedError(error: string | undefined): boolean {
  if (!error) return false;
  return /\b401\b|unauthorized|invalid[_ -]?token|token expired/i.test(error);
}

/**
 * True when `baseUrl` is safe to carry the token-exchange POST (actor M2M JWT +
 * Tier-1 Clerk JWT) and the JWKS trust-root fetch. HTTPS is required; plain HTTP
 * is permitted ONLY on loopback (dev/tests) — a cleartext/MITM'd JWKS would let
 * an attacker poison the keyset and forge a matching-kid RS256 token, defeating
 * the verifier (SEC-HTTPS; mirrors service-auth-config's `asHttpsUrl`).
 */
export function isSecureBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** Marker key the producer bridge (A4) lifts into a reply payload's channelData. */
export const OPENCLAW_COMPONENT_MARKER = "__openclaw_component";

function buildAgentTool(params: {
  entry: CatalogEntry;
  server: ServerRuntime;
  catalog: ToolCatalog;
  callTool: CallToolFn;
  governor: ConfirmGovernor;
  /** Session key from the tool-factory ctx — the seam that resolves externalId. */
  sessionKey: string;
  /** Resolve the verified externalId cached by before_agent_start for a session. */
  resolveExternalId: (sessionKey: string) => string | undefined;
  /** Resolve the live user JWT cached by before_agent_start (Tier 1) if present. */
  resolveUserJwt: (sessionKey: string) => string | undefined;
  /** The message channel from the tool-factory ctx (Tier-2 requested_subject scope). */
  messageChannel: string | undefined;
  logger: OpenClawPluginApi["logger"];
}) {
  const {
    entry,
    server,
    catalog,
    callTool,
    governor,
    sessionKey,
    resolveExternalId,
    resolveUserJwt,
    messageChannel,
    logger,
  } = params;
  const surfacedName = entry.descriptor.name;
  // Wire name = the ORIGINAL tool name the catalog preserved (PR#56 review). NOT
  // inferred by stripping a "<serverId>:" prefix — a tool whose natural name
  // legitimately starts with "<serverId>:" (e.g. server "kg" exposing "kg:search"
  // with no collision) would be mis-stripped to "search" and hit the wrong tool.
  const wireName = entry.wireName;

  return {
    name: surfacedName,
    label: surfacedName,
    description: entry.descriptor.description ?? `${server.label} MCP tool "${wireName}"`,
    parameters: toParameters(entry.descriptor.inputSchema),
    async execute(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
      const toolArgs = (args ?? {}) as Record<string, unknown>;
      // Resolve the current request's subject ONCE (fail-closed for m2m without
      // a verified identity happens inside server.getToken).
      const externalId = resolveExternalId(sessionKey);
      const subject: RequestSubject = {
        externalId,
        userJwt: resolveUserJwt(sessionKey),
        channel: messageChannel,
      };
      const callOnce = async (): Promise<McpToolResult> => {
        let token: string;
        try {
          // Fail-closed: never emit an unauthenticated call; the token value
          // is never interpolated into results — only the provider's message.
          token = await server.getToken(subject);
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
      } else if (
        !result.ok &&
        server.invalidateUserToken &&
        externalId &&
        isUnauthorizedError(result.error)
      ) {
        // A 401 at tool call → the exchanged user token is stale/rejected. Drop
        // the cached user token (same channel-scoped key), re-exchange, retry once.
        server.invalidateUserToken(subject);
        result = await callOnce();
      }

      const agentResult = toAgentResult(result);
      // Defense-in-depth (SEC-FORGE-MARKER): the component marker is a
      // GATEWAY-ONLY channel. Strip any pre-existing marker a backend smuggled
      // into the tool-result details BEFORE preview, so only a marker the
      // Governor itself stamps can ever reach the producer bridge.
      if (agentResult.details && typeof agentResult.details === "object") {
        delete (agentResult.details as Record<string, unknown>)[OPENCLAW_COMPONENT_MARKER];
      }
      if (result.ok) {
        // T4.2 PREVIEW: if this initiate result carries an allowlisted confirm
        // descriptor, the Governor mints a pending + stamps pending_id/expiry.
        // The stamped descriptor is marked for the producer bridge (A4) to lift
        // into the reply payload's channelData; failure never breaks the call.
        try {
          const previewed = governor.preview({
            toolResult: agentResult,
            externalId: resolveExternalId(sessionKey),
            sessionKey,
            serverId: server.id,
          });
          if (previewed) {
            agentResult.details = {
              ...(agentResult.details as Record<string, unknown>),
              [OPENCLAW_COMPONENT_MARKER]: {
                type: "component",
                component: previewed.descriptor,
              },
            };
          }
        } catch (err) {
          logger.error(`syntropy-mcp: preview error for "${surfacedName}": ${err}`);
        }
      }
      return agentResult;
    },
  };
}

/**
 * Build the default M2M actor-token provider for an m2m-exchange server: one
 * {@link ServiceAuthProvider} bound to the server's `resource`, sourcing the
 * machine secret from env (`CLERK_MACHINE_SECRET_KEY`). Returns `null` on a
 * config error (e.g. a non-URL resource) so the caller fails closed. The
 * provider itself fails closed at call time when the secret is absent (throws).
 */
function buildActorProvider(
  resource: string,
  env: NodeJS.ProcessEnv,
  logger: OpenClawPluginApi["logger"],
  serverId: string,
): ServiceAuthProvider | null {
  try {
    const cfg = resolveServiceAuthConfig({ resource }, env);
    return new ServiceAuthProvider(cfg);
  } catch (err) {
    const reason = err instanceof ServiceAuthConfigError ? err.reason : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `syntropy-mcp: server "${serverId}" actor-token config unresolved (${reason ?? "error"}): ${msg}`,
    );
    return null;
  }
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
      // m2m-exchange clients whose per-subject token caches the plugin sweeps on
      // its refresh tick (the clients own no timer — CODE-CACHE-EVICT).
      const exchangeClients: TokenExchangeClient[] = [];

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

        // m2m-exchange (B2) — RFC 8693 per-user token exchange (Option B signer).
        //
        // DISCOVERY (catalog getToken) uses the gateway's own M2M actor token —
        // listing a server's tools is a machine op with no user in scope.
        // TOOL EXECUTE (runtime getToken) exchanges that actor token for a
        // per-USER SJ-minted token, keyed on the current request's externalId.
        //
        // Every unmet precondition fails CLOSED the same way: register a rejecting
        // getToken (discovery + execute) so the server contributes ZERO tools,
        // with exactly one structured log line. Never throw (other servers stay up).
        const disableM2mServer = (detail: string): void => {
          api.logger.error(
            `syntropy-mcp: server "${spec.id}" (m2m-exchange) disabled — ${detail} (fail-closed, zero tools)`,
          );
          const reject = (): Promise<string> =>
            Promise.reject(new Error(`m2m disabled: ${detail}`));
          runtimes.set(spec.id, {
            id: spec.id,
            baseUrl: spec.baseUrl,
            label,
            getToken: reject,
            session,
          });
          catalogServers.push({ id: spec.id, baseUrl: spec.baseUrl, label, getToken: reject });
          sessionsByBaseUrl.set(spec.baseUrl, session);
        };

        // SEC-HTTPS: the baseUrl carries the exchange POST (actor + Tier-1 JWTs)
        // AND the JWKS trust-root fetch — refuse a cleartext/non-local baseUrl.
        if (!isSecureBaseUrl(spec.baseUrl)) {
          disableM2mServer("baseUrl is not https (or loopback http)");
          continue;
        }

        const resource = spec.resource as string; // validated by the parser
        // The actor-token provider (default: one ServiceAuthProvider per m2m
        // server, bound to that server's resource). Fail-CLOSED at call time when
        // the machine secret is absent (getToken throws) — never faked.
        const actorProvider =
          overrides.serviceAuthProvider !== undefined
            ? overrides.serviceAuthProvider
            : buildActorProvider(resource, env, api.logger, spec.id);

        if (!actorProvider) {
          // Config for the actor path is malformed (e.g. non-URL resource).
          disableM2mServer("actor-token config invalid");
          continue;
        }

        // DESIGN-MACHINESUB: a blank machineSub would let a token carrying
        // act:{sub:""} PASS the act.sub binding — disable (like a blank issuer),
        // do NOT merely warn.
        const machineSub = spec.machineSub ?? env.SYNTROPY_MCP_MACHINE_SUB ?? "";
        if (!machineSub) {
          disableM2mServer("no machineSub (config or SYNTROPY_MCP_MACHINE_SUB)");
          continue;
        }

        // Expected `iss` on the minted token — fail-closed if unresolvable (the
        // iss binding is a devex condition-of-approval; a blank issuer is unsafe).
        const issuer = spec.issuer ?? env.SYNTROPY_MCP_TOKEN_ISS ?? "";
        if (!issuer) {
          disableM2mServer("no issuer (config or SYNTROPY_MCP_TOKEN_ISS)");
          continue;
        }

        const exchangeClient = new TokenExchangeClient(
          {
            serverId: spec.id,
            baseUrl: spec.baseUrl,
            exchangePath: spec.exchangePath ?? "/api/tokens/exchange",
            resource,
            jwksPath: spec.jwksPath,
            machineSub,
            issuer,
          },
          {
            getActorToken: () => actorProvider.getToken(),
            fetchFn: overrides.exchangeFetch,
            verifyMintedToken: overrides.verifyMintedToken,
            now: overrides.now,
          },
        );
        exchangeClients.push(exchangeClient);

        // Resolve the current request's identity to an ExchangeSubject, or null
        // (fail-closed): Tier 1 needs a userJwt; Tier 2 needs a channel (SJ's
        // channel-scoped requested_subject "<channel>:<externalId>"). No
        // externalId, or a Tier-2 turn with no channel → null.
        const toExchangeSubject = (subject?: RequestSubject): ExchangeSubject | null => {
          const externalId = subject?.externalId;
          if (!externalId) return null;
          if (subject?.userJwt) return { tier: 1, externalId, userJwt: subject.userJwt };
          if (subject?.channel) return { tier: 2, externalId, channel: subject.channel };
          return null;
        };

        // Discovery: the machine actor token (no user in scope).
        const discoveryGetToken = (): Promise<string> => actorProvider.getToken();
        // Execute: the per-user exchanged token. Fail-CLOSED with no identity.
        const execGetToken = (subject?: RequestSubject): Promise<string> => {
          const exchangeSubject = toExchangeSubject(subject);
          if (!exchangeSubject) {
            return Promise.reject(new Error("no verified user identity (fail-closed)"));
          }
          return exchangeClient.getUserToken(exchangeSubject);
        };

        api.logger.info(
          `syntropy-mcp: server "${spec.id}" (m2m-exchange) enabled — per-user token exchange${
            actorProvider.secretMissing ? " (machine secret ABSENT → fail-closed at call)" : ""
          }`,
        );
        runtimes.set(spec.id, {
          id: spec.id,
          baseUrl: spec.baseUrl,
          label,
          getToken: execGetToken,
          invalidateUserToken: (subject: RequestSubject) => {
            // Invalidate the SAME cache key the exchange used (channel-scoped).
            const es = toExchangeSubject(subject);
            if (es) exchangeClient.invalidate(subjectId(es));
          },
          session,
        });
        catalogServers.push({
          id: spec.id,
          baseUrl: spec.baseUrl,
          label,
          getToken: discoveryGetToken,
        });
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

      // ------------------------------------------------------------------
      // B4 Confirm Governor — preview/confirm/commit-guard over the pending store
      // ------------------------------------------------------------------

      // Per-server commit-tool allowlist (B1/B4). Only servers that actually
      // registered a catalog server contribute — a fail-closed/excluded server
      // gates nothing. Empty for a server without a commitTools config.
      const registeredIds = new Set(serverIds);
      const commitToolsByServer = new Map<string, Set<string>>();
      for (const spec of config.servers) {
        if (!registeredIds.has(spec.id)) continue;
        commitToolsByServer.set(spec.id, new Set(spec.commitTools ?? []));
      }

      const hasGatedCommitTools = [...commitToolsByServer.values()].some((set) => set.size > 0);

      const pendingStore =
        overrides.pendingStore ??
        new PendingConfirmStore({ now: overrides.now, randomId: overrides.mintId });
      const governor =
        overrides.governor ??
        new ConfirmGovernor(pendingStore, { commitToolsByServer, now: overrides.now });

      // Seam: before_agent_start has ctx.externalId (verified caller) + sessionKey;
      // the sync tool factory and the before_tool_call guard have sessionKey only.
      // Cache externalId by sessionKey (bounded TTL, mirrors B1's user cache) so
      // both later stages resolve the identity the store isolates on.
      const externalIdBySession = new TtlCache<string, string>({
        ttlMs: 10 * 60_000,
        maxSize: 10_000,
      });
      const resolveExternalId = (sessionKey: string): string | undefined =>
        sessionKey ? externalIdBySession.get(sessionKey) : undefined;

      // B2 Tier 1: the live user Clerk JWT, cached alongside the externalId when
      // the before_agent_start ctx carries one. The current PluginHookAgentContext
      // exposes only `externalId`, so this stays empty (→ Tier 2 requested_subject)
      // until the host surfaces the raw JWT; the seam is here so Tier 1 lights up
      // with no further wiring. Cleared on the same identity downgrade as externalId.
      const userJwtBySession = new TtlCache<string, string>({
        ttlMs: 10 * 60_000,
        maxSize: 10_000,
      });
      const resolveUserJwt = (sessionKey: string): string | undefined =>
        sessionKey ? userJwtBySession.get(sessionKey) : undefined;

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
        // The store owns no timer (mirrors the catalog's "never self-schedule"
        // rule); the plugin's tick reclaims expired pendings.
        pendingStore.sweepExpired();
        // Same rule for the m2m per-subject token caches (CODE-CACHE-EVICT).
        for (const client of exchangeClients) client.sweepExpired();
      }, config.refreshSeconds * 1000);

      // ------------------------------------------------------------------
      // Tool factory (SYNC) — snapshot of the catalog at agent start
      // ------------------------------------------------------------------

      api.registerTool((ctx) => {
        try {
          const entries = catalog.getToolDescriptors();
          if (entries.length === 0) return null;
          const sessionKey = ctx.sessionKey ?? "";
          // The channel/surface for this run (Tier-2 requested_subject scope).
          const messageChannel = ctx.messageChannel;
          const tools = [];
          for (const entry of entries) {
            const server = runtimes.get(entry.serverId);
            if (!server) continue; // defensive: catalog only knows registered servers
            tools.push(
              buildAgentTool({
                entry,
                server,
                catalog,
                callTool,
                governor,
                sessionKey,
                resolveExternalId,
                resolveUserJwt,
                messageChannel,
                logger: api.logger,
              }),
            );
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
        async (event, ctx) => {
          try {
            // Cache the verified caller identity for this session so the sync
            // tool factory (preview) and the before_tool_call guard can resolve
            // it (their contexts carry sessionKey only). On an identity DOWNGRADE
            // (same session, no verified externalId this turn) DELETE the cached
            // identity — fail-closed, so a stale identity can never authorize a
            // replayed pending_id on an unverified turn.
            const sessionKey = ctx?.sessionKey ?? "";
            if (sessionKey) {
              if (ctx?.externalId) externalIdBySession.set(sessionKey, ctx.externalId);
              else externalIdBySession.delete(sessionKey);
              // Tier 1: cache the live user JWT if the host surfaces one; clear it
              // on any turn without one so a stale JWT can't be reused (fail-closed).
              const userJwt = readUserJwt(ctx);
              if (ctx?.externalId && userJwt) {
                userJwtBySession.set(sessionKey, userJwt);
              } else {
                userJwtBySession.delete(sessionKey);
              }
            }

            // T4.3 CONFIRM PARSE: if this raw turn is a CONFIRM/CANCEL directive,
            // validate + stage (or cancel) as a side effect. The staging result
            // does not change the binding (the guard does that) but its soft
            // note / hard error is surfaced so the user gets a re-prompt.
            let confirmNote: string | undefined;
            if (typeof event?.prompt === "string") {
              const parsed = governor.parseConfirmTurn(event.prompt, ctx?.externalId ?? undefined);
              if (parsed.error) {
                confirmNote = `[SYNTROPY_MCP] Your confirmation was not applied: ${parsed.error}. Re-send the confirmation with valid values.`;
              } else if (parsed.note) {
                confirmNote = `[SYNTROPY_MCP] ${parsed.note}`;
              }
            }

            const names = catalog.getToolDescriptors().map((entry) => entry.descriptor.name);
            if (names.length === 0) {
              return confirmNote ? { prependContext: confirmNote } : {};
            }
            let prependContext = `[SYNTROPY_MCP] Discovered MCP tools available: ${names.join(", ")}`;
            // Advertise the confirm protocol ONLY when a commit tool is gated, so
            // a plain discovery config keeps its single-line context.
            if (hasGatedCommitTools) {
              prependContext +=
                "\n[SYNTROPY_MCP] When the user sends a `<CONFIRM pending_id=… fields={…}>` turn, " +
                "call the named commit tool passing that pending_id — the gateway binds the reviewed values.";
            }
            if (confirmNote) prependContext += `\n${confirmNote}`;
            return { prependContext };
          } catch (err) {
            api.logger.error(`syntropy-mcp: before_agent_start error: ${err}`);
            return {};
          }
        },
        { priority: 30 },
      );

      // ------------------------------------------------------------------
      // Hook: before_tool_call (priority 40) — T4.4 COMMIT GUARD (the CRIT fix)
      // ------------------------------------------------------------------

      api.on(
        "before_tool_call",
        async (event, ctx) => {
          try {
            return governor.guardBeforeToolCall(event, resolveExternalId(ctx?.sessionKey ?? ""));
          } catch (err) {
            api.logger.error(`syntropy-mcp: before_tool_call guard error: ${err}`);
            // Fail-closed: if the guard itself throws on a commit tool, block it.
            // Key on the SURFACED name (via the governor's resolver) so a
            // collision-prefixed commit tool is still caught here.
            if (governor.isGatedCommitTool(event.toolName)) {
              return { block: true, blockReason: "Confirmation guard error — action blocked." };
            }
            return undefined;
          }
        },
        { priority: 40 },
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
