import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
// Gateway Clerk-verify + session deny-list — extension→src deep import per the
// established convention (kapso precedent); src never imports extensions.
import { authorizeClerkJwt, resolveClerkAuth } from "../../../src/gateway/auth.js";
import { evictClerkSessionCache } from "../../../src/gateway/clerk-session-validation.js";
// Session-key parsing is shared with auth-memory-gate + syntropy so the
// convention can't drift across the three identity hooks (oc-hygiene #7).
import { deriveChannel, deriveIdentityPeer } from "../../shared/session-key.js";
import { registerIdentityCommands } from "./commands.js";
import { formatIdentityContext, formatUnknownUserContext } from "./context.js";
import {
  autoBindVerifiedPeer,
  createPgClient,
  ensureUserSchema,
  findUserByChannelPeer,
  unlinkChannelPeerForUser,
} from "./db.js";
import type { AuthConfig } from "./jwt.js";
import { createMobileSignoutHandler, SIGNOUT_ROUTE_PATH } from "./signout-route.js";

/**
 * Channels whose peers AUTO-BIND on a verified first-party turn (G-lane [G1]).
 * Scoped to the mobile channel per the approved A&D §7 — external channels
 * (WhatsApp) keep the one-time pairing flow; webchat is out of G1 scope.
 */
const AUTO_BIND_CHANNELS = new Set(["shrinemobile"]);

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
          // Canonical peer: the threaded device id when present (mobile), else
          // the session-key-derived peer — MUST match auth-memory-gate (shared fn).
          const peerId = deriveIdentityPeer(ctx);

          // G-lane [G1] auto-bind: a VERIFIED first-party turn (server-verified
          // Clerk sub on ctx.externalId) on an auto-bind channel ensures the
          // lp_users row + the (channel, device-id) link BEFORE the identity
          // lookup below and before auth-memory-gate (priority 40) runs — so the
          // signed-in mobile user is verified from their FIRST message and the
          // gate never fires (A&D R1a). Bind failures log and fall through:
          // the turn proceeds; the gate then treats the peer as unverified
          // (fail-closed, never fail-open).
          const externalId = ctx?.externalId?.trim();
          const deviceId = ctx?.deviceId?.trim();
          if (externalId && deviceId && AUTO_BIND_CHANNELS.has(channel)) {
            try {
              await autoBindVerifiedPeer(sql, {
                externalId,
                channel,
                channelPeerId: deviceId,
              });
            } catch (err) {
              api.logger.error(`persist-user-identity: [G1] auto-bind failed: ${err}`);
            }
          }

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
    // G-lane [G2]: POST /gateway/mobile/signout — unbind the caller's OWN
    // (shrinemobile, device-id) link + deny the session id ([G2b]).
    // Registered here because this plugin owns the pg client + lp_* schema.
    // -------------------------------------------------------------------

    api.registerHttpRoute({
      path: SIGNOUT_ROUTE_PATH,
      handler: createMobileSignoutHandler({
        // Same config sources as the CHAT verify path (config-file clerk block
        // OR OPENCLAW_CLERK_* env) — an operator configuring via the config
        // file must not end up with working chat but a permanently-401 unbind.
        resolveClerk: () => resolveClerkAuth(api.config.gateway?.auth?.clerk, process.env),
        verifyJwt: (token, clerk) => authorizeClerkJwt(token, clerk),
        unlink: async (params) => {
          await ensureReady();
          return unlinkChannelPeerForUser(sql, params);
        },
        evictSession: (sessionId) => evictClerkSessionCache(sessionId),
        logger: api.logger,
      }),
    });

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
