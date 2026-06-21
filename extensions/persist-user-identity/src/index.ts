import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// Session-key parsing is shared with auth-memory-gate + syntropy so the
// convention can't drift across the three identity hooks (oc-hygiene #7).
import { deriveChannel, derivePeerId } from "../../shared/session-key.js";
import { registerIdentityCommands } from "./commands.js";
import { formatIdentityContext, formatUnknownUserContext } from "./context.js";
import { createPgClient, ensureUserSchema, findUserByChannelPeer } from "./db.js";
import type { AuthConfig } from "./jwt.js";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const persistUserIdentityPlugin = {
  id: "persist-user-identity",
  name: "User Identity (PostgreSQL)",
  description:
    "Cross-channel user identity persistence with optional token verification. " +
    "Extends persist-postgres with lp_users and lp_user_channels tables.",

  register(api: OpenClawPluginApi) {
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    if (!databaseUrl) {
      api.logger.warn("persist-user-identity: no databaseUrl or DATABASE_URL env, plugin disabled");
      return;
    }

    const authConfig = api.pluginConfig?.auth as AuthConfig | undefined;

    // Track pending !identify results so !verify can use the email as user_identifier
    const pendingIdentify = new Map<string, { email: string; userId: string; expiresAt: number }>();

    api.logger.info("persist-user-identity: connecting to PostgreSQL");
    const sql = createPgClient(databaseUrl);
    let schemaReady = false;
    let initError: unknown = null;

    async function ensureReady() {
      if (schemaReady) {
        return;
      }
      if (initError) {
        throw initError;
      }
      try {
        await sql`SELECT 1`;
        await ensureUserSchema(sql);
        schemaReady = true;
        api.logger.info("persist-user-identity: schema ready");
      } catch (err) {
        initError = err;
        api.logger.error(`persist-user-identity: init failed: ${err}`);
        throw err;
      }
    }

    // -------------------------------------------------------------------
    // Hook: before_agent_start — resolve identity and inject context
    // Priority 60 — runs before persist-postgres (50) so that downstream
    // hooks can access the identity context.
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
          if (identity) {
            return { prependContext: formatIdentityContext(identity, "new_session") };
          }

          return { prependContext: formatUnknownUserContext(channel, peerId) };
        } catch (err) {
          api.logger.error(`persist-user-identity: before_agent_start error: ${err}`);
          return {};
        }
      },
      { priority: 60 },
    );

    // -------------------------------------------------------------------
    // Commands: !verify, !identify, !register, !whoami (see ./commands.ts)
    // -------------------------------------------------------------------

    registerIdentityCommands(api, { sql, authConfig, ensureReady, pendingIdentify });

    // -------------------------------------------------------------------
    // Shutdown: close DB pool
    // -------------------------------------------------------------------

    api.on(
      "gateway_stop",
      async () => {
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("persist-user-identity: database connections closed");
        } catch (err) {
          api.logger.error(`persist-user-identity: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default persistUserIdentityPlugin;
