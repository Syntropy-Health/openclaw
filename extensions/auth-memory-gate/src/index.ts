import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import postgres from "postgres";
import {
  deriveChannel,
  derivePeerId,
  findUserByChannelPeer,
  resolveScope,
  formatScopeBlock,
  type ScopeConfig,
} from "./scope.js";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const authMemoryGatePlugin = {
  id: "auth-memory-gate",
  name: "Memory Scope Gate",
  description:
    "Identity-scoped memory retrieval gate. Reads user identity from persist-user-identity's " +
    "database and injects a [MEMORY_SCOPE] block for downstream memory plugins.",

  register(api: OpenClawPluginApi) {
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    if (!databaseUrl) {
      api.logger.warn("auth-memory-gate: no databaseUrl or DATABASE_URL env, plugin disabled");
      return;
    }

    const scopeConfig: ScopeConfig = {
      requireVerified: (api.pluginConfig?.requireVerified as boolean | undefined) ?? false,
      gateMessage: (api.pluginConfig?.gateMessage as string | undefined) ?? undefined,
    };

    api.logger.info("auth-memory-gate: connecting to PostgreSQL");
    const sql = postgres(databaseUrl, { max: 10 });

    // Lazy init: verify DB connectivity on first hook call, cache errors
    let dbReady = false;
    let initError: unknown = null;

    async function ensureReady() {
      if (dbReady) {
        return;
      }
      if (initError) {
        throw initError;
      }
      try {
        await sql`SELECT 1`;
        dbReady = true;
        api.logger.info("auth-memory-gate: DB connection verified");
      } catch (err) {
        initError = err;
        api.logger.error(`auth-memory-gate: init failed (will not retry): ${err}`);
        throw err;
      }
    }

    // -------------------------------------------------------------------
    // Hook: before_agent_start — resolve identity and inject scope
    // Priority 40 — runs after identity (60) and persistence (50),
    // but before memory plugins (default 0).
    // -------------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        try {
          await ensureReady();
          const sessionKey = ctx?.sessionKey ?? "";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const peerId = derivePeerId(sessionKey);

          if (!peerId || peerId === "main" || peerId === "unknown") {
            return {};
          }

          const identity = await findUserByChannelPeer(sql, channel, peerId);
          if (!identity) {
            // User not registered — persist-user-identity handles this case
            return {};
          }

          const scope = resolveScope(identity, channel, peerId);
          const prependContext = formatScopeBlock(scope, scopeConfig);

          api.logger.info(
            `auth-memory-gate: scope resolved for ${channel}:${peerId} → ` +
              `key=${scope.scopeKey} verified=${scope.verified}`,
          );

          return { prependContext };
        } catch (err) {
          api.logger.error(`auth-memory-gate: before_agent_start error: ${err}`);
          return {};
        }
      },
      { priority: 40 },
    );

    // -------------------------------------------------------------------
    // Shutdown: close DB pool
    // -------------------------------------------------------------------

    api.on(
      "gateway_stop",
      async () => {
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("auth-memory-gate: database connections closed");
        } catch (err) {
          api.logger.error(`auth-memory-gate: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default authMemoryGatePlugin;
