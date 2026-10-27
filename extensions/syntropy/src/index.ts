/**
 * Syntropy Health — consolidated OpenClaw extension.
 *
 * Owns the full lifecycle from identity gate to tool execution:
 *
 * 1. **before_agent_start** (priority 35) — Verifies the user has a stored
 *    Syntropy auth token.  Caches the resolved user for the tool factory.
 *    If no token, injects `[SYNTROPY_GATE]`.
 *
 * 2. **Tool factory** (sync) — Returns 9 health tools for users whose token
 *    was resolved in the hook.  Unverified users get no tools (hard gate).
 *
 * 3. **Token storage** — `syntropy_tokens` table (one per user, keyed by
 *    `lp_users.id`).  Tokens stored after `!verify` via persist-user-identity.
 *
 * Priority ordering:
 *   60  persist-user-identity
 *   50  persist-postgres
 *   40  auth-memory-gate
 *   35  syntropy (THIS)
 *    0  memory-graphiti
 */

import { createRetryingInit, openPluginPool, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import postgres from "postgres";
import { isHttpGateChannel, isHttpShapedSession } from "../../shared/http-channels.js";
import { TtlCache } from "./cache.js";
import { callSyntropyTool, type SyntropyToolResult } from "./client.js";
import { parseSyntropyConfig } from "./config.js";
import {
  ensureSyntropySchema,
  migrateTokenToCipher,
  readStoredTokenWithSource,
  type StoredTokenRow,
} from "./db.js";
import { createAllKgTools } from "./kg-tools.js";
import { resolveProfileContext } from "./profile-context.js";
import { resolveServiceAuthConfig, ServiceAuthConfigError } from "./service-auth-config.js";
import { ServiceAuthProvider } from "./service-auth.js";
import { deriveChannel, derivePeerId } from "./session-key.js";
import { tokenCipherFromEnv, TokenCipherError, type TokenCipher } from "./token-cipher.js";
import { createAllTools } from "./tools.js";
import { createBraintrustTracer, type TracedFn, type Tracer } from "./tracer.js";
import { createSyntropyVault, vaultRpcsInstalled, type SyntropyVault } from "./vault.js";

// Per-session ResolvedUser cache parameters — bounded to prevent unbounded
// growth on long-running gateways. 10 min TTL means stale tokens drop out
// after server-side rotation; 10k entries comfortably exceeds expected
// active-user count per gateway instance.
const USER_CACHE_TTL_MS = 10 * 60 * 1000;
const USER_CACHE_MAX_SIZE = 10_000;
/** A verified turn's record: the user cache key plus its sub (lowercased). */
type VerifiedSessionRecord = { cacheKey: string; sub: string };

/**
 * The user-scope segment of a gateway HTTP session key
 * (`agent:<id>:openresponses-user:<sub>[:h…]` / `openai-user:<sub>…`),
 * lowercased as stored; undefined when the key has no such segment.
 */
export function sessionScopeSub(sessionKey: string): string | undefined {
  const parts = sessionKey.split(":");
  if (parts.length < 4 || parts[0] !== "agent") return undefined;
  if (parts[2] !== "openresponses-user" && parts[2] !== "openai-user") return undefined;
  const sub = parts[3]?.trim().toLowerCase();
  return sub || undefined;
}

// sessionKey → verified record (see verifiedSessions in register()).
const VERIFIED_SESSION_TTL_MS = 2 * 60 * 1000;

// Session-key parsing moved to ./session-key.ts for testability.

// ---------------------------------------------------------------------------
// Identity + token resolution
// ---------------------------------------------------------------------------

interface ResolvedUser {
  userId: string;
  externalId: string;
  authToken: string;
}

export async function resolveUser(
  sql: postgres.Sql,
  vault: SyntropyVault | null,
  channel: string,
  peerId: string,
  cipher: TokenCipher | null = null,
  onTokenError?: (code: string) => void,
  onMigrate?: (ok: boolean) => void,
): Promise<ResolvedUser | null> {
  const rows = await sql`
    SELECT u.id, u.external_id, st.auth_token, st.vault_secret_name, st.token_ciphertext
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    LEFT JOIN syntropy_tokens st ON st.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${peerId}
    LIMIT 1
  `;
  return finishResolve(sql, vault, rows[0], cipher, onTokenError, onMigrate);
}

/**
 * Resolve a VERIFIED caller by their server-verified external id (the Clerk
 * `sub` the gateway threads on `ctx.externalId`) — never by a peer derived from
 * the session key, which a client can steer (e.g. a hint ending in
 * `direct:<victim>`). Token read + lazy migration are identical to
 * {@link resolveUser} (shared {@link finishResolve}).
 */
export async function resolveUserByExternalId(
  sql: postgres.Sql,
  vault: SyntropyVault | null,
  externalId: string,
  cipher: TokenCipher | null = null,
  onTokenError?: (code: string) => void,
  onMigrate?: (ok: boolean) => void,
): Promise<ResolvedUser | null> {
  const rows = await sql`
    SELECT u.id, u.external_id, st.auth_token, st.vault_secret_name, st.token_ciphertext
    FROM lp_users u
    LEFT JOIN syntropy_tokens st ON st.user_id = u.id
    WHERE u.external_id = ${externalId}
    LIMIT 1
  `;
  return finishResolve(sql, vault, rows[0], cipher, onTokenError, onMigrate);
}

/** Shared token read + lazy cipher migration for a resolved lp_users row. */
async function finishResolve(
  sql: postgres.Sql,
  vault: SyntropyVault | null,
  row: postgres.Row | undefined,
  cipher: TokenCipher | null,
  onTokenError?: (code: string) => void,
  onMigrate?: (ok: boolean) => void,
): Promise<ResolvedUser | null> {
  if (!row?.external_id) return null;

  // Ciphertext first, then Vault, then legacy plaintext (db.ts readStoredToken).
  // A stored token that cannot be opened fails CLOSED and LOUD: the user is
  // treated as unpaired for this turn, and the named code is reported. The token
  // never appears in the report.
  // Only a token-store failure (TokenCipherError: tamper, wrong key, no cipher, Vault reference
  // without a Vault) is caught here. Any OTHER error (a Vault RPC or network blip) propagates as
  // before, so a transient failure does not tell a paired user to re-pair.
  let read: Awaited<ReturnType<typeof readStoredTokenWithSource>>;
  try {
    read = await readStoredTokenWithSource(row as StoredTokenRow, row.id as string, vault, cipher);
  } catch (err) {
    if (!(err instanceof TokenCipherError)) throw err;
    onTokenError?.(err.code);
    return null;
  }

  if (!read) return null;
  const authToken = read.token;
  // Lazy migration: an unencrypted row read with a cipher loaded is re-encrypted in place.
  if (cipher && read.source !== "cipher") {
    try {
      await migrateTokenToCipher(sql, row.id as string, authToken, cipher);
      onMigrate?.(true);
    } catch {
      onMigrate?.(false);
    }
  }

  return {
    userId: row.id as string,
    externalId: row.external_id as string,
    authToken,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const SYNTROPY_GATE = `[SYNTROPY_GATE]
status: LOCKED
reason: No Syntropy auth token found for this user.

Health tools (food logging, diet scoring, check-ins) are NOT available.
The user needs to complete pairing first:
1. Log in to the Syntropy Journals app
2. Open Settings → "Pair Device" to get a 6-digit code
3. Type: !verify <code>
[/SYNTROPY_GATE]`;

/**
 * The data gate for HTTP surfaces (shrinemobile, webchat). Chat commands do not
 * dispatch there, so this copy must NEVER tell the user to type `!verify` (or any
 * command) or to fetch a pairing code: that instruction is a dead end the user
 * cannot complete (measured on staging 2026-10-23, CTO #16865). Honest and
 * short, with no promised date. The real mobile access path is mono #595.
 */
export const SYNTROPY_GATE_HTTP = `[SYNTROPY_GATE]
status: LOCKED
reason: No Syntropy auth token found for this user.

Health tools (food logging, diet scoring, check-ins) are NOT available.
Linking health data is not available in this app yet.
If the user asks for something that needs their health data, say plainly that
it is not available in this app yet. Do not give a date. Do not tell them to
type any command or to pair a device; those steps do not work here.
[/SYNTROPY_GATE]`;

/** The data-gate block for `channel`: command-free copy on HTTP surfaces. */
export function syntropyGateFor(channel: string | null | undefined): string {
  return isHttpGateChannel(channel) ? SYNTROPY_GATE_HTTP : SYNTROPY_GATE;
}

/**
 * Decide the `before_agent_start` result for a (possibly-resolved) user —
 * extracted from the hook closure so the wiring is unit-testable without a DB.
 *
 * - **Unpaired** (`user === null`): clear any cached identity/profile for this
 *   key (so a stale block from a prior pairing can't leak post-unpair) and gate.
 * - **Paired**: cache the user for the sync tool factory, then inject the
 *   health-profile block as `prependContext` (SYN-206) — without the agent
 *   calling the profile tool. Identity-scoped by `cacheKey`; failure-safe
 *   (a null/failed/empty profile yields `{}`, never blocks the reply).
 */
export async function decideProfileInjection(opts: {
  user: ResolvedUser | null;
  cacheKey: string;
  /**
   * The turn's channel. REQUIRED (not optional) so a call site cannot forget it
   * and silently fall back to the `!verify` copy on an HTTP surface.
   */
  channel: string;
  resolvedUsers: TtlCache<string, ResolvedUser>;
  profileBlocks: TtlCache<string, string>;
  fetchProfile: (authToken: string) => Promise<SyntropyToolResult>;
  /** Optional single-flight map (dedup concurrent profile fetches). */
  profileInFlight?: Map<string, Promise<string | null>>;
  /** Optional short-TTL "no usable profile" memo (skip per-turn re-fetch). */
  profileNegative?: TtlCache<string, true>;
}): Promise<{ prependContext?: string }> {
  const {
    user,
    cacheKey,
    channel,
    resolvedUsers,
    profileBlocks,
    fetchProfile,
    profileInFlight,
    profileNegative,
  } = opts;

  if (!user) {
    resolvedUsers.delete(cacheKey);
    profileBlocks.delete(cacheKey);
    profileNegative?.delete(cacheKey);
    return { prependContext: syntropyGateFor(channel) };
  }

  resolvedUsers.set(cacheKey, user);
  const block = await resolveProfileContext({
    cache: profileBlocks,
    cacheKey,
    fetchProfile: () => fetchProfile(user.authToken),
    inFlight: profileInFlight,
    negativeCache: profileNegative,
  });
  return block ? { prependContext: block } : {};
}

/**
 * Build the openclaw → SJ `/mcp` **service-auth (M2M)** token provider at
 * register time, if the `resource` URI is configured (P2 wire contract, T2.2).
 *
 * This is the documented seam: the provider is constructed here and exposed on
 * the plugin closure so openclaw's eventual MCP-tool consumption of SJ `/mcp`
 * (and the P1 matrix client) can attach `Authorization: Bearer <M2M JWT>` via
 * `callMcpToolWithServiceAuth` / `provider.buildAuthHeaders`.
 *
 * Construction is best-effort and NON-fatal: a missing `resource` simply means
 * no machine path is configured (the per-user `sj_*` path is unaffected), so we
 * log and return `null` rather than disabling the whole plugin. The provider
 * itself fails **closed** at call time when `CLERK_MACHINE_SECRET_KEY` is absent
 * — i.e. it never emits an unauthenticated request; it throws so the caller
 * surfaces it.
 *
 * Env consumed (provisioned by devex via Infisical):
 *   - `CLERK_MACHINE_SECRET_KEY` — openclaw's Clerk machine secret (`ak_…`).
 *   - `SYNTROPY_MCP_RESOURCE_URL` — canonical SJ `/mcp` URI for this env
 *     (alternative to `pluginConfig.resource`).
 *   - `CLERK_API_URL` (optional) — Clerk BAPI override.
 */
export function maybeCreateServiceAuthProvider(
  pluginConfig: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
  logger: { info: (m: string) => void; warn: (m: string) => void },
): ServiceAuthProvider | null {
  // Plugin-facing key is `serviceAuthResource`; the resolver's input field is
  // `resource` (devex/UI-friendly name → internal claim name). Remap here.
  const resourceInput =
    typeof pluginConfig?.serviceAuthResource === "string"
      ? { resource: pluginConfig.serviceAuthResource as string }
      : {};
  try {
    const cfg = resolveServiceAuthConfig(resourceInput, env);
    const provider = new ServiceAuthProvider(cfg);
    // Length-only debug — NEVER log the secret value (CLAUDE.md secrets rule).
    const secretLen = env.CLERK_MACHINE_SECRET_KEY?.length ?? 0;
    logger.info(
      `syntropy: service-auth enabled (resource=${cfg.resource}, machineSecret=${secretLen > 0 ? `len=${secretLen}` : "ABSENT→fail-closed"})`,
    );
    return provider;
  } catch (err) {
    const reason = err instanceof ServiceAuthConfigError ? err.reason : undefined;
    const msg = err instanceof Error ? err.message : String(err);
    if (reason === "missing-resource") {
      // Benign: the machine path is simply not configured (the per-user sj_*
      // path is orthogonal and unaffected). Info, not warn.
      logger.info(
        "syntropy: service-auth (openclaw→SJ /mcp M2M) not configured — machine path disabled.",
      );
    } else {
      // A `resource`/CLERK_API_URL is PRESENT but malformed — a real misconfig
      // that silently disabling the machine path would mask. Fail loudly (F11).
      logger.warn(`syntropy: service-auth MISCONFIGURED — machine path disabled — ${msg}`);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Braintrust observability init (PHI-safe, default-OFF)
// ---------------------------------------------------------------------------

/** Minimal logger surface used by the braintrust init (matches api.logger). */
interface InitLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Resolved braintrust config slice consumed by {@link initBraintrustTracer}. */
interface BraintrustInit {
  enabled: boolean;
  apiKey?: string;
  projectName: string;
  logContent: boolean;
}

/**
 * Initialize Braintrust ONCE and return a PHI-safe {@link Tracer}, or
 * `undefined` when tracing is off / cannot start. Fail-safe: never throws —
 * a missing key or a failed dynamic import disables tracing without crashing
 * register().
 *
 * The `braintrust` dep is loaded lazily INSIDE the enabled branch so the
 * default-OFF path never pulls it in at runtime. `loadBraintrust` is injected
 * so tests can mock the SDK without a real network/login.
 *
 * @returns a Tracer when initialized; `undefined` when disabled or unavailable.
 */
export async function initBraintrustTracer(
  cfg: BraintrustInit,
  logger: InitLogger,
  loadBraintrust: () => Promise<{
    initLogger: (opts: { projectName: string; apiKey?: string }) => unknown;
    traced: TracedFn;
  }> = () =>
    import("braintrust") as unknown as Promise<{
      initLogger: (opts: { projectName: string; apiKey?: string }) => unknown;
      traced: TracedFn;
    }>,
): Promise<Tracer | undefined> {
  if (!cfg.enabled) return undefined;

  if (!cfg.apiKey) {
    // Fail-safe: enabled but no key (e.g. BRAINTRUST_API_KEY unset in
    // Infisical). Warn + run un-traced rather than throw/crash register.
    logger.warn(
      "syntropy: braintrust enabled but no apiKey (set BRAINTRUST_API_KEY) — tracing disabled",
    );
    return undefined;
  }

  try {
    const { initLogger, traced } = await loadBraintrust();
    // Initialize the project logger exactly once. setCurrent (default) makes
    // module-level `traced` attach spans to this logger.
    initLogger({ projectName: cfg.projectName, apiKey: cfg.apiKey });
    logger.info(
      `syntropy: braintrust enabled (project=${cfg.projectName}, logContent=${cfg.logContent})`,
    );
    if (cfg.logContent) {
      logger.warn(
        "syntropy: braintrust logContent=true — MCP inputs/outputs (PHI) will be sent to " +
          "Braintrust cloud. QA / synthetic-data ONLY.",
      );
    }
    return createBraintrustTracer(traced, cfg.logContent);
  } catch (err) {
    // Dynamic import or login failure must never break the plugin.
    logger.error(
      `syntropy: braintrust init failed — tracing disabled: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

const syntropyPlugin = {
  id: "syntropy",
  name: "Syntropy Health Integration",
  description:
    "Identity gate, token storage, and health tools for Syntropy Health. " +
    "Requires persist-user-identity and auth-memory-gate plugins.",

  register(api: OpenClawPluginApi) {
    let config;
    try {
      config = parseSyntropyConfig(
        api.pluginConfig as Record<string, unknown> | undefined,
        process.env,
      );
    } catch (err) {
      // In production, missing config is a fail-fast: don't silently route to
      // localhost. In dev, parseSyntropyConfig falls back gracefully.
      api.logger.error(
        `syntropy: ${err instanceof Error ? err.message : String(err)} — plugin disabled`,
      );
      return;
    }
    const { syntropyBaseUrl, databaseUrl, kgBaseUrl, enableKgDirect, braintrust } = config;
    // SYN-33 — KG-direct tools register only when explicitly configured
    // (kgBaseUrl set) and not explicitly opted out (enableKgDirect !== false).
    // Absent enableKgDirect defaults to true; explicit false is a hard opt-out.
    const kgEnabled = kgBaseUrl !== undefined && enableKgDirect !== false;

    // Braintrust observability (default-OFF). Kicked off async; the resolved
    // tracer is consumed by the tool factory, which only ever fires at request
    // time — well after this init settles. While settling (or when disabled /
    // unavailable), `tracer` stays undefined → byte-identical un-traced path.
    let tracer: Tracer | undefined;
    void initBraintrustTracer(braintrust, api.logger)
      .then((t) => {
        tracer = t;
      })
      .catch((err) => api.logger.error(`syntropy: braintrust init error: ${err}`));

    const sql = openPluginPool(postgres, databaseUrl, { logger: api.logger, plugin: "syntropy" });

    // Service-auth (M2M) provider for openclaw → SJ /mcp machine calls (P2
    // T2.2). Constructed here as the documented seam; the future MCP client /
    // P1 matrix client attaches its Bearer via callMcpToolWithServiceAuth.
    // `serviceAuth` is intentionally unused by the per-user paths below — it is
    // the drop-in point for machine-authenticated /mcp consumption.
    const serviceAuth = maybeCreateServiceAuthProvider(
      api.pluginConfig as Record<string, unknown> | undefined,
      process.env,
      api.logger,
    );
    void serviceAuth; // seam: consumed by the eventual MCP-tool machine path.

    // Supabase Vault is the production storage for `sj_*` tokens. Backed by
    // the same Postgres connection we already use for `lp_users` etc.
    // (SJ + openclaw share the Supabase project `vouzkcwwkpqsgiquemwp`.)
    // We probe for the SECURITY DEFINER RPCs at startup and fall back to
    // the legacy plaintext `auth_token` column path when they aren't
    // installed yet (pre-migration deploys, local dev).
    let vault: SyntropyVault | null = null;
    // App-side token encryption (Cloud SQL move): on when OPENCLAW_TOKEN_KEK_NAME and
    // OPENCLAW_TOKEN_DEK_WRAPPED are both present. Loaded per lookup (memoized), NOT inside
    // ensureStorage: a cipher failure must disable only encrypted rows, not the Vault path
    // or the whole plugin. While it fails, encrypted rows report no_cipher (unpaired + loud).
    let cipherState = "";
    const currentCipher = async (): Promise<TokenCipher | null> => {
      try {
        const c = await tokenCipherFromEnv();
        if (c && cipherState !== `ok:${c.keyId}`) {
          cipherState = `ok:${c.keyId}`;
          api.logger.info(`syntropy: token store = app cipher (key id ${c.keyId})`);
        }
        return c;
      } catch (err) {
        const code = err instanceof TokenCipherError ? err.code : "error";
        if (cipherState !== code) {
          cipherState = code;
          api.logger.error(
            `syntropy: token cipher DISABLED (${code}); encrypted tokens unreadable`,
          );
        }
        return null;
      }
    };

    // Schema + vault detection, RETRIED with backoff. This ran once at register
    // and a failure was final: vault stayed null, so vault-stored tokens were
    // unreadable (paired users looked unpaired) until restart. Started eagerly
    // here, and awaited (bounded by the backoff window) before each lookup.
    const ensureStorage = createRetryingInit(
      async () => {
        await ensureSyntropySchema(sql);
        if (await vaultRpcsInstalled(sql)) {
          vault = createSyntropyVault(sql);
          api.logger.info("syntropy: vault=supabase (RPCs installed)");
        } else {
          vault = null;
          api.logger.warn(
            "syntropy: vault absent — token writes need the app cipher (or OPENCLAW_ALLOW_PLAINTEXT_TOKENS=1, dev only)",
          );
        }
      },
      { logger: api.logger, plugin: "syntropy" },
    );
    ensureStorage().catch(() => {
      /* logged by createRetryingInit; retried on the next lookup */
    });

    api.logger.info(
      `syntropy: enabled (base=${syntropyBaseUrl}, kg=${kgEnabled ? kgBaseUrl : "disabled"})`,
    );

    // Cache resolved user per session key — populated by before_agent_start,
    // consumed by the synchronous tool factory. Bounded by TTL + size so
    // long-running gateways don't accumulate stale entries indefinitely.
    const resolvedUsers = new TtlCache<string, ResolvedUser>({
      ttlMs: USER_CACHE_TTL_MS,
      maxSize: USER_CACHE_MAX_SIZE,
    });

    // Cache the formatted [SYNTROPY_PROFILE] block per session key — populated
    // by resolveProfileContext from before_agent_start so a paired user's
    // profile is injected without the agent calling the health-profile tool.
    // Same 10-min TTL / 10k bound as resolvedUsers; keyed by the same
    // ${channel}:${peerId} so a user can never receive another user's profile.
    const profileBlocks = new TtlCache<string, string>({
      ttlMs: USER_CACHE_TTL_MS,
      maxSize: USER_CACHE_MAX_SIZE,
    });

    // sessionKey → cacheKey (`ext:<externalId>`) for VERIFIED turns, written by
    // before_agent_start and read by the sync tool factory (whose ctx carries no
    // externalId). Rewritten (set OR deleted) as the FIRST statement of every
    // hook run, so a later unverified run on the same key cannot reuse it. Short
    // TTL: the factory runs right after the hook (run.ts early hook → attempt.ts
    // createOpenClawCodingTools), so a record only needs to outlive one run.
    const verifiedSessions = new TtlCache<string, VerifiedSessionRecord>({
      ttlMs: VERIFIED_SESSION_TTL_MS,
      maxSize: USER_CACHE_MAX_SIZE,
    });

    // Single-flight: concurrent messages from one user that both miss the
    // profile cache share ONE get_health_profile fetch instead of racing two.
    const profileInFlight = new Map<string, Promise<string | null>>();

    // Short-TTL memo of "no usable profile" so an empty/unusable profile isn't
    // re-fetched from SJ on EVERY turn (the positive cache only holds real
    // blocks). 60s ≪ the 10-min positive TTL so web-app edits still appear soon.
    const PROFILE_NEGATIVE_TTL_MS = 60_000;
    const profileNegative = new TtlCache<string, true>({
      ttlMs: PROFILE_NEGATIVE_TTL_MS,
      maxSize: USER_CACHE_MAX_SIZE,
    });

    // -----------------------------------------------------------------
    // Hook: before_agent_start (priority 35)
    // -----------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        // FIRST statement, before any await or anything that can throw: this
        // run's verified-session record for the key is either (re)written or
        // removed, so a record from an earlier VERIFIED run on the same session
        // key can never serve a later unverified run's tool factory.
        //
        // Runner isolation (src/plugins/hooks.ts runModifyingHook, global runner
        // catchErrors: true): each handler's throw is caught and the loop goes on,
        // so another plugin failing does not skip this handler. But if the runner
        // call ITSELF rejects in run.ts (early call, caught there), attempt.ts
        // builds the tools (createOpenClawCodingTools) BEFORE its late rerun of
        // before_agent_start — so the factory CAN run for a run in which this hook
        // has not executed. It then sees only a record ≤ VERIFIED_SESSION_TTL_MS
        // old from an earlier run on the same key; the short TTL bounds that.
        const recordKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
        const recordSub = typeof ctx?.externalId === "string" ? ctx.externalId.trim() : "";
        if (recordKey) {
          if (recordSub) {
            verifiedSessions.set(recordKey, {
              cacheKey: `ext:${recordSub}`,
              sub: recordSub.toLowerCase(),
            });
          } else {
            verifiedSessions.delete(recordKey);
          }
        }
        try {
          const sessionKey = ctx?.sessionKey ?? "";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const onTokenError = (code: string) =>
            api.logger.error(
              `syntropy: stored token unreadable (${code}); user treated as unpaired`,
            );
          const onMigrate = (ok: boolean) =>
            ok
              ? api.logger.info("syntropy: migrated one stored token to ciphertext")
              : api.logger.warn(
                  "syntropy: could not migrate a stored token to ciphertext; kept as is",
                );

          // A VERIFIED turn (server-verified Clerk sub on ctx.externalId) resolves
          // by external_id ONLY. The session-key-derived peer is never consulted:
          // its tail is client-influenced, and a steered peer would load another
          // user's identity and SJ token.
          const externalId = ctx?.externalId?.trim();
          if (externalId) {
            // The session record was written at the top of the handler, so the
            // factory sees this session as verified even if the lookup fails (it
            // then finds no cached user and returns no tools — fail closed).
            const cacheKey = `ext:${externalId}`;
            await ensureStorage();
            const user = await resolveUserByExternalId(
              sql,
              vault,
              externalId,
              await currentCipher(),
              onTokenError,
              onMigrate,
            );
            return await decideProfileInjection({
              user,
              cacheKey,
              channel,
              resolvedUsers,
              profileBlocks,
              profileInFlight,
              profileNegative,
              fetchProfile: (authToken) =>
                callSyntropyTool(syntropyBaseUrl, authToken, "get_health_profile", {}),
            });
          }

          const peerId = derivePeerId(sessionKey);

          // No peer (e.g. the operator Control UI on `agent:main:main`): nothing
          // to gate or resolve — unchanged behaviour, no copy injected.
          if (!peerId || peerId === "main" || peerId === "unknown") return {};

          // An UNVERIFIED HTTP-shaped session is unidentified: its session-key
          // tail (body `user`, a raw session-key header) is client-chosen, so it
          // must never select a (channel, peer) row.
          if (isHttpShapedSession(channel, sessionKey)) {
            return { prependContext: SYNTROPY_GATE_HTTP };
          }

          const cacheKey = `${channel}:${peerId}`;
          await ensureStorage();
          const user = await resolveUser(
            sql,
            vault,
            channel,
            peerId,
            await currentCipher(),
            onTokenError,
            onMigrate,
          );

          return await decideProfileInjection({
            user,
            cacheKey,
            channel,
            resolvedUsers,
            profileBlocks,
            profileInFlight,
            profileNegative,
            fetchProfile: (authToken) =>
              callSyntropyTool(syntropyBaseUrl, authToken, "get_health_profile", {}),
          });
        } catch (err) {
          api.logger.error(`syntropy: before_agent_start error: ${err}`);
          return {};
        }
      },
      { priority: 35 },
    );

    // -----------------------------------------------------------------
    // Tool factory (SYNC) — reads from cache populated by the hook.
    // -----------------------------------------------------------------

    api.registerTool((ctx) => {
      try {
        const sessionKey = ctx.sessionKey ?? "";
        const channel = ctx.messageChannel ?? deriveChannel(sessionKey);

        // The factory has no externalId on its ctx: a verified turn is recognised
        // by the sessionKey → cacheKey record the hook wrote. An HTTP session
        // WITHOUT such a record gets no tools (fail closed) — its derived peer is
        // client-influenced and must never select a cached user.
        const verified = sessionKey ? verifiedSessions.get(sessionKey) : undefined;
        let cacheKey: string;
        if (verified) {
          // Bind the record to the session's OWN user scope: the key minted for a
          // verified turn is `…:openresponses-user:<sub>[:h…]` (lowercased). If the
          // key's scope is another sub, or the key has no scope, no tools. This
          // covers the window where the hook did not run for this run (see the
          // runner note in before_agent_start).
          if (sessionScopeSub(sessionKey) !== verified.sub) return null;
          cacheKey = verified.cacheKey;
        } else {
          if (isHttpShapedSession(channel, sessionKey)) return null;
          const peerId = derivePeerId(sessionKey);
          if (!peerId || peerId === "main" || peerId === "unknown") return null;
          cacheKey = `${channel}:${peerId}`;
        }
        const user = resolvedUsers.get(cacheKey);
        if (!user) return null;

        // `tracer` is undefined unless braintrust is enabled + initialized —
        // then each MCP call is wrapped in a PHI-safe span.
        const sjTools = createAllTools(syntropyBaseUrl, user.authToken, tracer);
        if (!kgEnabled) return sjTools;
        // SYN-33 — KG-direct tools share the same sj_* Bearer (ADR-001 §2);
        // no second token exchange. kg-mcp does atomic quota_check_and_debit
        // server-side per ADR-001 §5 — the extension is metering-unaware.
        const kgTools = createAllKgTools(kgBaseUrl, user.authToken, tracer);
        return [...sjTools, ...kgTools];
      } catch (err) {
        api.logger.error(`syntropy: tool factory error: ${err}`);
        return null;
      }
    });

    // -----------------------------------------------------------------
    // Shutdown
    // -----------------------------------------------------------------

    api.on(
      "gateway_stop",
      async () => {
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("syntropy: database connections closed");
        } catch (err) {
          api.logger.error(`syntropy: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default syntropyPlugin;
