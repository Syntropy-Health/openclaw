import { openPluginPool, type OpenClawPluginApi } from "openclaw/plugin-sdk";
import postgres from "postgres";
import {
  deriveChannel,
  deriveIdentityPeer,
  findUserByChannelPeer,
  reconcileVerifiedIdentity,
  resolveScope,
  formatScopeBlock,
  formatHardGateSystemPrompt,
  formatHardGateReplyAppend,
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
    "database and injects a [MEMORY_SCOPE] block for downstream memory plugins. " +
    "Optionally enforces a hard gate that locks the agent to verification-only mode.",

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
    const hardGate = (api.pluginConfig?.hardGate as boolean | undefined) ?? false;

    api.logger.info(
      `auth-memory-gate: connecting to PostgreSQL (hardGate=${hardGate}, requireVerified=${scopeConfig.requireVerified})`,
    );
    const sql = openPluginPool(postgres, databaseUrl, {
      logger: api.logger,
      plugin: "auth-memory-gate",
    });

    // Lazy init with RETRY (R5). A failed probe is remembered only for a
    // backoff window (1s, 2s, 4s ... capped at 60s), then retried on the next
    // turn — never cached for the life of the process, which previously left a
    // transient boot-time failure (e.g. "too many connections for role") in
    // place until restart. Inside the window the cached error is rethrown
    // without a new probe, so a burst of turns cannot become a probe storm.
    let dbReady = false;
    let lastInitError: unknown = null;
    let initFailures = 0;
    let nextProbeAt = 0;

    async function ensureReady() {
      if (dbReady) {
        return;
      }
      if (lastInitError && Date.now() < nextProbeAt) {
        throw lastInitError;
      }
      try {
        await sql`SELECT 1`;
        dbReady = true;
        lastInitError = null;
        initFailures = 0;
        api.logger.info("auth-memory-gate: DB connection verified");
      } catch (err) {
        initFailures += 1;
        const delayMs = Math.min(1_000 * 2 ** (initFailures - 1), 60_000);
        lastInitError = err;
        nextProbeAt = Date.now() + delayMs;
        api.logger.error(
          `auth-memory-gate: init failed (attempt ${initFailures}, retry in ${delayMs / 1000}s): ${err}`,
        );
        throw err;
      }
    }

    // Track gated peers in memory for the message_sending safety net.
    // Keyed by "channel:peerId" — rebuilt on each before_agent_start call.
    const gatedPeers = new Set<string>();

    // -------------------------------------------------------------------
    // Hook: before_agent_start — resolve identity and inject scope
    // Priority 40 — runs after identity (60) and persistence (50),
    // but before memory plugins (default 0).
    // -------------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        // Peer derivation is pure (no DB), so it happens BEFORE any DB call:
        // the fail-closed path below must know whom to gate.
        const sessionKey = ctx?.sessionKey ?? "";
        const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
        // Canonical peer via the SHARED helper (device-id when threaded, else
        // session-key-derived) — MUST match persist-user-identity's [G1] bind
        // key, or the gate would miss the just-bound mobile row (A&D §7).
        const peerId = deriveIdentityPeer(ctx);

        if (!peerId || peerId === "main" || peerId === "unknown") {
          return {};
        }

        const gateKey = `${channel}:${peerId}`;
        try {
          await ensureReady();
          // Cross-check the peer row against the turn's VERIFIED identity
          // (fail-closed defense-in-depth): on a verified turn a stale/contested
          // row keyed by the client-supplied device id must NEVER key this turn
          // onto another user's scope — treat it as unidentified instead.
          const identity = reconcileVerifiedIdentity(
            await findUserByChannelPeer(sql, channel, peerId),
            ctx?.externalId,
          );

          if (!identity) {
            // User not registered
            if (hardGate) {
              gatedPeers.add(gateKey);
              api.logger.info(`auth-memory-gate: hard gate active for ${gateKey}`);
              return { prependContext: formatHardGateSystemPrompt(channel, peerId) };
            }
            return {};
          }

          // User exists — clear gate
          gatedPeers.delete(gateKey);

          const scope = resolveScope(identity, channel, peerId);

          // Gate unverified users when requireVerified + hardGate are both on
          if (scopeConfig.requireVerified && !scope.verified && hardGate) {
            gatedPeers.add(gateKey);
            api.logger.info(`auth-memory-gate: hard gate (unverified) for ${gateKey}`);
            return { prependContext: formatHardGateSystemPrompt(channel, peerId) };
          }

          const prependContext = formatScopeBlock(scope, scopeConfig);

          api.logger.info(
            `auth-memory-gate: scope resolved for ${channel}:${peerId} → ` +
              `key=${scope.scopeKey} verified=${scope.verified}`,
          );

          return { prependContext };
        } catch (err) {
          api.logger.error(`auth-memory-gate: before_agent_start error: ${err}`);
          // R5: with hardGate on, an unknown identity (DB down, role connection
          // limit, lookup failure) is treated as UNVERIFIED — gate the turn.
          // Returning {} here was a fail-OPEN: every peer ungated while the DB
          // was unreachable. Without hardGate the gate is advisory, so {} stays.
          if (hardGate) {
            gatedPeers.add(gateKey);
            return { prependContext: formatHardGateSystemPrompt(channel, peerId) };
          }
          return {};
        }
      },
      { priority: 40 },
    );

    // -------------------------------------------------------------------
    // Hook: message_sending — safety net for hard gate
    // Priority 30 — appends a verification CTA to outgoing messages
    // when the recipient peer is in the gated set.
    // -------------------------------------------------------------------

    if (hardGate) {
      api.on(
        "message_sending",
        async (event, ctx) => {
          try {
            const channel = ctx?.channelId ?? "unknown";
            const to = event.to ?? "";
            const peerGateKey = `${channel}:${to}`;

            if (gatedPeers.has(peerGateKey)) {
              return { content: (event.content ?? "") + formatHardGateReplyAppend() };
            }
            return {};
          } catch (err) {
            api.logger.error(`auth-memory-gate: message_sending error: ${err}`);
            return {};
          }
        },
        { priority: 30 },
      );
    }

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
