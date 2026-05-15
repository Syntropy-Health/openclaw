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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import postgres from "postgres";
import { TtlCache } from "./cache.js";
import { parseSyntropyConfig } from "./config.js";
import { ensureSyntropySchema } from "./db.js";
import { createAllKgTools } from "./kg-tools.js";
import { deriveChannel, derivePeerId } from "./session-key.js";
import { createAllTools } from "./tools.js";
import { createSyntropyVault, vaultRpcsInstalled, type SyntropyVault } from "./vault.js";

// Per-session ResolvedUser cache parameters — bounded to prevent unbounded
// growth on long-running gateways. 10 min TTL means stale tokens drop out
// after server-side rotation; 10k entries comfortably exceeds expected
// active-user count per gateway instance.
const USER_CACHE_TTL_MS = 10 * 60 * 1000;
const USER_CACHE_MAX_SIZE = 10_000;

// Session-key parsing moved to ./session-key.ts for testability.

// ---------------------------------------------------------------------------
// Identity + token resolution
// ---------------------------------------------------------------------------

interface ResolvedUser {
  userId: string;
  externalId: string;
  authToken: string;
}

async function resolveUser(
  sql: postgres.Sql,
  vault: SyntropyVault | null,
  channel: string,
  peerId: string,
): Promise<ResolvedUser | null> {
  const rows = await sql`
    SELECT u.id, u.external_id, st.auth_token, st.vault_secret_name
    FROM lp_users u
    JOIN lp_user_channels uc ON uc.user_id = u.id
    LEFT JOIN syntropy_tokens st ON st.user_id = u.id
    WHERE uc.channel = ${channel}
      AND uc.channel_peer_id = ${peerId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row?.external_id) return null;

  // Prefer vault path (post-migration); fall back to legacy plaintext (pre-migration).
  let authToken: string | null = null;
  const vaultSecretName = row.vault_secret_name as string | null;
  if (vaultSecretName && vault) {
    authToken = await vault.get(vaultSecretName);
  } else if (row.auth_token) {
    authToken = row.auth_token as string;
  }

  if (!authToken) return null;

  return {
    userId: row.id as string,
    externalId: row.external_id as string,
    authToken,
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const SYNTROPY_GATE = `[SYNTROPY_GATE]
status: LOCKED
reason: No Syntropy auth token found for this user.

Health tools (food logging, diet scoring, check-ins) are NOT available.
The user needs to complete pairing first:
1. Log in to the Syntropy web app
2. Click "Link Device" to get a 6-digit code
3. Type: !verify <code>
[/SYNTROPY_GATE]`;

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
    const { syntropyBaseUrl, databaseUrl, kgBaseUrl, enableKgDirect } = config;
    // SYN-33 — KG-direct tools register only when explicitly configured
    // (kgBaseUrl set) and not explicitly opted out (enableKgDirect !== false).
    // Absent enableKgDirect defaults to true; explicit false is a hard opt-out.
    const kgEnabled = kgBaseUrl !== undefined && enableKgDirect !== false;

    const sql = postgres(databaseUrl, { max: 5 });

    // Supabase Vault is the production storage for `sj_*` tokens. Backed by
    // the same Postgres connection we already use for `lp_users` etc.
    // (SJ + openclaw share the Supabase project `vouzkcwwkpqsgiquemwp`.)
    // We probe for the SECURITY DEFINER RPCs at startup and fall back to
    // the legacy plaintext `auth_token` column path when they aren't
    // installed yet (pre-migration deploys, local dev).
    let vault: SyntropyVault | null = null;

    ensureSyntropySchema(sql)
      .then(async () => {
        if (await vaultRpcsInstalled(sql)) {
          vault = createSyntropyVault(sql);
          api.logger.info("syntropy: vault=supabase (RPCs installed)");
        } else {
          api.logger.warn(
            "syntropy: vault=legacy-plaintext — install supabase-migrations/0001 to enable vault path",
          );
        }
      })
      .catch((err) => api.logger.error(`syntropy: schema init failed: ${err}`));

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

    // -----------------------------------------------------------------
    // Hook: before_agent_start (priority 35)
    // -----------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        try {
          const sessionKey = ctx?.sessionKey ?? "";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const peerId = derivePeerId(sessionKey);

          if (!peerId || peerId === "main" || peerId === "unknown") return {};

          const cacheKey = `${channel}:${peerId}`;
          const user = await resolveUser(sql, vault, channel, peerId);

          if (!user) {
            resolvedUsers.delete(cacheKey);
            return { prependContext: SYNTROPY_GATE };
          }

          // Cache for the tool factory
          resolvedUsers.set(cacheKey, user);
          return {};
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
        const peerId = derivePeerId(sessionKey);

        if (!peerId || peerId === "main" || peerId === "unknown") return null;

        const cacheKey = `${channel}:${peerId}`;
        const user = resolvedUsers.get(cacheKey);
        if (!user) return null;

        const sjTools = createAllTools(syntropyBaseUrl, user.authToken);
        if (!kgEnabled) return sjTools;
        // SYN-33 — KG-direct tools share the same sj_* Bearer (ADR-001 §2);
        // no second token exchange. kg-mcp does atomic quota_check_and_debit
        // server-side per ADR-001 §5 — the extension is metering-unaware.
        const kgTools = createAllKgTools(kgBaseUrl, user.authToken);
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
