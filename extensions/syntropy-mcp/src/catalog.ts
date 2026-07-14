/**
 * Per-server discovered-MCP-tool cache for the syntropy-mcp plugin.
 *
 * The catalog is transport-agnostic: discovery goes through an injectable
 * `listTools` function (defaulting to the shared Streamable-HTTP
 * `listMcpTools` transport) and auth goes through each server's `getToken`
 * seam (static key or M2M provider behind it). It is primed asynchronously
 * via {@link ToolCatalog.refresh} and read synchronously via
 * {@link ToolCatalog.getToolDescriptors}.
 *
 * Staleness policy (fail-closed):
 * - A server that has never successfully refreshed contributes zero tools.
 * - After a failed refresh the previous tool set keeps being served while
 *   its age is within `maxStaleSeconds` ("stale-while-refreshing").
 * - Past `maxStaleSeconds`, mutating tools are dropped; read tools keep
 *   being served, tagged `staleness: "stale"`.
 *
 * The catalog never self-schedules timers — the plugin drives `refresh()`
 * (use {@link ToolCatalog.needsRefresh} to decide when a refresh is due).
 *
 * Mapping descriptors to executable agent tools is the next layer up — this
 * module deliberately stops at descriptors + staleness policy.
 */

import {
  listMcpTools,
  type McpToolDescriptor,
  type McpToolListResult,
} from "../../syntropy/src/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpServerConfig = {
  /** Server id, e.g. "sj", "kg". Used to tag descriptors and prefix collisions. */
  id: string;
  baseUrl: string;
  /** Auth-agnostic seam — static key or M2M provider behind it. */
  getToken: () => Promise<string>;
  /** Error-message label; defaults to `id`. */
  label?: string;
};

/** Discovery transport signature — matches `listMcpTools`. */
export type ListToolsFn = (
  baseUrl: string,
  authToken: string,
  opts: { label: string },
) => Promise<McpToolListResult>;

export type CatalogLog = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type CatalogOptions = {
  /** Cache TTL: a server fetched longer ago than this is due for refresh. Default 300. */
  refreshSeconds?: number;
  /** Fail-closed horizon for mutating tools. Default 3 * refreshSeconds. */
  maxStaleSeconds?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
  log?: CatalogLog;
  /** Injectable discovery transport for tests. Default {@link listMcpTools}. */
  listTools?: ListToolsFn;
};

export type CatalogEntry = {
  serverId: string;
  descriptor: McpToolDescriptor;
  /**
   * The tool's ORIGINAL wire name (what the MCP server knows it as) — preserved
   * explicitly because `descriptor.name` may be collision-prefixed with
   * "<serverId>:" for surfacing. Never infer the wire name by stripping that
   * prefix: a tool whose natural name legitimately starts with "<serverId>:"
   * would be mis-stripped (PR#56 review).
   */
  wireName: string;
  staleness: "fresh" | "stale";
};

export type ServerCacheState = {
  fetchedAt: number | null;
  lastError: string | null;
  toolCount: number;
};

type RefreshErrorCallback = (serverId: string, error: string) => void;

type ServerEntry = {
  config: McpServerConfig;
  tools: McpToolDescriptor[];
  fetchedAt: number | null;
  lastError: string | null;
  inFlight: Promise<void> | null;
};

const NOOP_LOG: CatalogLog = { info: () => {}, warn: () => {}, error: () => {} };

const DEFAULT_REFRESH_SECONDS = 300;

// ---------------------------------------------------------------------------
// ToolCatalog
// ---------------------------------------------------------------------------

export class ToolCatalog {
  private readonly servers = new Map<string, ServerEntry>();
  private readonly refreshSeconds: number;
  private readonly maxStaleSeconds: number;
  private readonly now: () => number;
  private readonly log: CatalogLog;
  private readonly listTools: ListToolsFn;
  private readonly errorCallbacks: RefreshErrorCallback[] = [];

  constructor(servers: McpServerConfig[], opts?: CatalogOptions) {
    this.refreshSeconds = opts?.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
    this.maxStaleSeconds = opts?.maxStaleSeconds ?? 3 * this.refreshSeconds;
    this.now = opts?.now ?? Date.now;
    this.log = opts?.log ?? NOOP_LOG;
    this.listTools = opts?.listTools ?? listMcpTools;
    for (const config of servers) {
      this.servers.set(config.id, {
        config,
        tools: [],
        fetchedAt: null,
        lastError: null,
        inFlight: null,
      });
    }
  }

  /**
   * Discover tools for one server (or all servers when `serverId` is omitted).
   * Never rejects on discovery failure — failures are recorded in `lastState`
   * and surfaced via {@link onRefreshError}. Single-flighted per server.
   */
  async refresh(serverId?: string): Promise<void> {
    if (serverId !== undefined) {
      await this.refreshServer(this.requireServer(serverId));
      return;
    }
    await Promise.all([...this.servers.values()].map((entry) => this.refreshServer(entry)));
  }

  /** Synchronous cache read applying the staleness policy. */
  getToolDescriptors(): CatalogEntry[] {
    const nowMs = this.now();
    const out: CatalogEntry[] = [];
    const seenNames = new Set<string>();

    for (const entry of this.servers.values()) {
      // Fail-closed: a server never successfully refreshed contributes zero tools.
      if (entry.fetchedAt === null) continue;

      const ageSeconds = (nowMs - entry.fetchedAt) / 1000;
      const staleness: CatalogEntry["staleness"] =
        ageSeconds <= this.refreshSeconds ? "fresh" : "stale";
      const pastMaxStale = ageSeconds > this.maxStaleSeconds;

      for (const descriptor of entry.tools) {
        // Fail-closed (A&D S6/R6): past the stale horizon, only tools that are
        // PROVABLY read-only survive. Absent/ambiguous annotations mean "not
        // provably read-only" — a compromised backend must not keep write
        // tools alive past the safety net simply by omitting annotations.
        if (pastMaxStale && !this.isProvablyReadOnly(descriptor)) continue;

        let surfaced = descriptor;
        if (seenNames.has(descriptor.name)) {
          const prefixed = `${entry.config.id}:${descriptor.name}`;
          this.log.warn(
            `syntropy-mcp catalog: tool name collision on "${descriptor.name}" — surfacing ${entry.config.id}'s as "${prefixed}"`,
          );
          surfaced = { ...descriptor, name: prefixed };
        }
        seenNames.add(surfaced.name);
        // wireName is the ORIGINAL descriptor.name (pre-prefix) — the name the MCP
        // server actually knows; `surfaced.name` may be collision-prefixed.
        out.push({
          serverId: entry.config.id,
          descriptor: surfaced,
          wireName: descriptor.name,
          staleness,
        });
      }
    }

    return out;
  }

  /**
   * A tool is PROVABLY read-only only when its annotations positively assert
   * it. This is the predicate for the max-stale fail-closed drop (A&D S6) —
   * strictly stronger than `!isMutating` (which is the GATING read-default).
   */
  isProvablyReadOnly(descriptor: McpToolDescriptor): boolean {
    const annotations = descriptor.annotations;
    if (!annotations) return false;
    // Fail-closed veto (PR#56 review): ANY mutation-suggesting annotation
    // disqualifies. A compromised backend must not keep a write tool alive past
    // the max-stale drop (S6) by pairing readOnlyHint:true with mutates:true, or
    // assert read-only via readOnlyHint:false. Reusing isMutating guarantees this
    // predicate stays STRICTLY STRONGER than !isMutating (the documented invariant).
    if (this.isMutating(descriptor)) return false;
    // Then require an affirmative read-only assertion.
    return annotations.readOnlyHint === true || annotations.mutates === false;
  }

  /**
   * GATING predicate: a tool is mutating when its annotations say so; absent
   * annotations mean NOT mutating (read-default, A&D "read-tool defaults").
   * NOTE: the max-stale drop deliberately does NOT use this — see
   * isProvablyReadOnly.
   */
  isMutating(descriptor: McpToolDescriptor): boolean {
    const annotations = descriptor.annotations;
    if (!annotations) return false;
    return (
      annotations.mutates === true ||
      annotations.requires_confirm === true ||
      annotations.readOnlyHint === false
    );
  }

  onRefreshError(cb: RefreshErrorCallback): void {
    this.errorCallbacks.push(cb);
  }

  lastState(serverId: string): ServerCacheState {
    const entry = this.requireServer(serverId);
    return {
      fetchedAt: entry.fetchedAt,
      lastError: entry.lastError,
      toolCount: entry.tools.length,
    };
  }

  /**
   * True when a refresh is due: the server has never been fetched or its
   * `fetchedAt` is older than `refreshSeconds`. The catalog never schedules
   * timers itself — the plugin drives `refresh()` off this signal.
   */
  needsRefresh(serverId: string): boolean {
    const entry = this.requireServer(serverId);
    if (entry.fetchedAt === null) return true;
    return (this.now() - entry.fetchedAt) / 1000 > this.refreshSeconds;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireServer(serverId: string): ServerEntry {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`syntropy-mcp catalog: unknown server "${serverId}"`);
    return entry;
  }

  private refreshServer(entry: ServerEntry): Promise<void> {
    if (entry.inFlight) return entry.inFlight;
    const inFlight = this.doRefresh(entry).finally(() => {
      entry.inFlight = null;
    });
    entry.inFlight = inFlight;
    return inFlight;
  }

  private async doRefresh(entry: ServerEntry): Promise<void> {
    const label = entry.config.label ?? entry.config.id;

    let token: string;
    try {
      token = await entry.config.getToken();
    } catch (err) {
      // Fail-closed: no unauthenticated discovery. The token value is never
      // interpolated here — only the provider's error message.
      const msg = err instanceof Error ? err.message : String(err);
      this.recordError(entry, `${label} auth failed: ${msg}`);
      return;
    }

    const result = await this.listTools(entry.config.baseUrl, token, { label });
    if (!result.ok) {
      this.recordError(entry, result.error);
      return;
    }

    entry.tools = result.tools;
    entry.fetchedAt = this.now();
    entry.lastError = null;
  }

  private recordError(entry: ServerEntry, error: string): void {
    entry.lastError = error;
    this.log.error(`syntropy-mcp catalog: refresh failed for "${entry.config.id}": ${error}`);
    for (const cb of this.errorCallbacks) {
      try {
        cb(entry.config.id, error);
      } catch (cbErr) {
        const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
        this.log.warn(`syntropy-mcp catalog: onRefreshError callback threw: ${msg}`);
      }
    }
  }
}
