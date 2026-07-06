import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createPgClient, ensureSchema, persistMessage, purgeExpiredConversations } from "./db.js";

// How often the retention sweep runs when a retention window is configured.
const PURGE_INTERVAL_MS = 60 * 60 * 1000; // hourly

const persistPostgresPlugin = {
  id: "persist-postgres",
  name: "Persist (PostgreSQL)",
  description: "Persists sessions and messages to PostgreSQL instead of local files",
  register(api: OpenClawPluginApi) {
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    if (!databaseUrl) {
      api.logger.warn(
        "persist-postgres: no databaseUrl in plugin config or DATABASE_URL env, plugin disabled",
      );
      return;
    }

    api.logger.info(`persist-postgres: connecting to PostgreSQL`);
    const sql = createPgClient(databaseUrl);
    let schemaReady = false;
    let initError: unknown = null;

    // Transcript retention: when retentionDays > 0, expired conversations (and
    // their cascaded message content) are swept periodically so the persisted
    // chat store stays session-only / short-lived. Unset or <= 0 = keep forever
    // (backward-compatible default).
    const retentionDays = Number(api.pluginConfig?.retentionDays ?? 0);
    let purgeTimer: ReturnType<typeof setInterval> | undefined;

    async function ensureReady() {
      if (schemaReady) {
        return;
      }
      if (initError) {
        throw initError;
      }
      try {
        await sql`SELECT 1`;
        await ensureSchema(sql);
        schemaReady = true;
        api.logger.info("persist-postgres: schema ready");
      } catch (err) {
        initError = err;
        api.logger.error(`persist-postgres: init failed (will not retry): ${err}`);
        throw err;
      }
    }

    // Schedule the retention sweep when a window is configured. The timer is
    // unref'd so it never keeps the process alive, and cleared on gateway_stop.
    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      api.logger.info(`persist-postgres: transcript retention enabled (${retentionDays}d sweep)`);
      purgeTimer = setInterval(() => {
        ensureReady()
          .then(() => purgeExpiredConversations(sql, retentionDays))
          .then((purged) => {
            if (purged > 0) {
              api.logger.info(
                `persist-postgres: purged ${purged} conversation(s) older than ${retentionDays}d`,
              );
            }
          })
          .catch((err) => api.logger.error(`persist-postgres: retention sweep error: ${err}`));
      }, PURGE_INTERVAL_MS);
      purgeTimer.unref?.();
    }

    // Persist the user prompt when an agent run starts
    api.on(
      "before_agent_start",
      async (event, ctx) => {
        try {
          if (!event.prompt) {
            return {};
          }
          await ensureReady();
          const sessionKey = ctx?.sessionKey ?? "unknown";
          await persistMessage(sql, {
            sessionKey,
            channel: "gateway",
            lastMessageAt: new Date(),
            role: "user",
            content: event.prompt,
          });
          api.logger.info(`persist-postgres: persisted user message for session ${sessionKey}`);
        } catch (err) {
          api.logger.error(`persist-postgres: before_agent_start error: ${err}`);
        }
        return {};
      },
      { priority: 50 },
    );

    // Persist the agent's response after the run ends
    api.on(
      "agent_end",
      async (event, ctx) => {
        try {
          type Msg = { role?: string; content?: unknown };
          const messages = (event.messages ?? []) as Msg[];
          const lastAssistant = messages.toReversed().find((m) => m.role === "assistant");
          if (!lastAssistant) {
            return;
          }
          await ensureReady();
          const sessionKey = ctx?.sessionKey ?? "unknown";
          const content =
            typeof lastAssistant.content === "string"
              ? lastAssistant.content
              : JSON.stringify(lastAssistant.content);
          await persistMessage(sql, {
            sessionKey,
            channel: "gateway",
            lastMessageAt: new Date(),
            role: "assistant",
            content,
          });
          api.logger.info(
            `persist-postgres: persisted assistant message for session ${sessionKey}`,
          );
        } catch (err) {
          api.logger.error(`persist-postgres: agent_end error: ${err}`);
        }
      },
      { priority: 50 },
    );

    // Close connection pool on gateway shutdown
    api.on(
      "gateway_stop",
      async (_event, _ctx) => {
        try {
          if (purgeTimer) {
            clearInterval(purgeTimer);
          }
          await sql.end({ timeout: 5 });
          api.logger.info("persist-postgres: database connections closed");
        } catch (err) {
          api.logger.error(`persist-postgres: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default persistPostgresPlugin;
