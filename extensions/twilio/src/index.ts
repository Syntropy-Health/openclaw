/**
 * Twilio SMS channel extension entry (B-Twilio-1, slice 5d).
 *
 * Wires the tested building blocks into a live channel:
 *  - durable opt-out store (ADR 0001: OpenClaw's OWN Postgres, never the Journal),
 *  - the `sms` ChannelPlugin (outbound send),
 *  - the `/twilio/sms` inbound webhook: X-Twilio-Signature gate → TCPA compliance
 *    (STOP/START/HELP handled BEFORE the agent) → agent dispatch for real messages.
 *
 * The channel stays inert until credential-complete; with no DATABASE_URL the
 * opt-out store fails closed (sends suppressed) rather than risking a message to
 * a number that may have opted out.
 */

import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { dispatchInboundMessageWithDispatcher } from "../../../src/auto-reply/dispatch.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import { buildAgentPeerSessionKey, DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { resolveSmsAccount, SMS_CHANNEL_ID } from "./accounts.js";
import { createSmsPlugin } from "./channel.js";
import { guardedSendSms, handleInboundCompliance, type OptOutStore } from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { asSqlTag, createSmsPgClient, type SmsPgClient } from "./db.js";
import { createPgOptOutStore, ensureOptOutSchema } from "./optout-store.js";
import { createSmsWebhookHandler, type InboundSms } from "./webhook.js";

/**
 * A store that throws on every read — used when no durable DB is available. Via
 * `guardedSendSms`'s fail-closed catch, this suppresses ALL sends: an unprovable
 * opt-out state must never let a message through.
 */
const FAIL_CLOSED_STORE: OptOutStore = {
  isOptedOut: () => {
    throw new Error("sms opt-out store unavailable");
  },
  optOut: () => {},
  optIn: () => {},
};

/** Build the inbound message context + dispatch a real (non-compliance) SMS to the agent. */
async function routeInboundToAgent(params: {
  inbound: InboundSms;
  cfg: OpenClawConfig;
  config: ResolvedTwilioSmsConfig;
  store: OptOutStore;
}): Promise<void> {
  const { inbound, cfg, config, store } = params;
  const sessionKey = buildAgentPeerSessionKey({
    agentId: DEFAULT_AGENT_ID,
    channel: SMS_CHANNEL_ID,
    peerKind: "direct",
    peerId: inbound.from,
    dmScope: "per-channel-peer",
  });
  const ctx: MsgContext = {
    Body: inbound.body,
    From: inbound.from,
    To: config.smsNumber,
    SessionKey: sessionKey,
    Provider: SMS_CHANNEL_ID,
    Surface: SMS_CHANNEL_ID,
    ChatType: "direct",
  };
  await dispatchInboundMessageWithDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      // The agent's reply goes back out through the opt-out-guarded send path.
      deliver: async (payload) => {
        const text = payload.text?.trim();
        if (text) await guardedSendSms({ config, to: inbound.from, body: text }, store);
      },
    },
  });
}

const twilioSmsPlugin = {
  id: "twilio",
  name: "SMS (Twilio)",
  description:
    "Two-way SMS via Twilio: outbound send, X-Twilio-Signature inbound webhook, TCPA opt-out rail.",

  async register(api: OpenClawPluginApi) {
    // Durable opt-out store — ADR 0001: OpenClaw's OWN Postgres (DATABASE_URL), never the Journal PHI DB.
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    let store: OptOutStore = FAIL_CLOSED_STORE;
    let sql: SmsPgClient | null = null;
    if (databaseUrl) {
      sql = createSmsPgClient(databaseUrl);
      try {
        await ensureOptOutSchema(asSqlTag(sql));
        store = createPgOptOutStore(asSqlTag(sql));
        api.logger.info("twilio: opt-out store ready (pg)");
      } catch (err) {
        api.logger.error(
          `twilio: opt-out schema init failed; sends will fail-closed: ${String(err)}`,
        );
      }
    } else {
      api.logger.warn(
        "twilio: no DATABASE_URL — opt-out store unavailable; sends fail-closed until provisioned",
      );
    }

    // Outbound channel.
    api.registerChannel({ plugin: createSmsPlugin({ store }) });

    // Inbound webhook: signature gate → compliance-first → agent.
    api.registerHttpRoute({
      path: "/twilio/sms",
      handler: createSmsWebhookHandler({
        resolveConfig: () => resolveSmsAccount(api.config).config,
        onInbound: async (inbound) => {
          const config = resolveSmsAccount(api.config).config;
          if (!config) return;
          // TCPA rail: STOP/START/HELP handled BEFORE the agent ever sees the message.
          const outcome = await handleInboundCompliance(inbound.from, inbound.body, store);
          if (outcome.kind !== "passthrough") {
            await guardedSendSms({ config, to: inbound.from, body: outcome.reply }, store);
            return;
          }
          await routeInboundToAgent({ inbound, cfg: api.config, config, store });
        },
      }),
    });

    // Close the pool on shutdown.
    api.on("gateway_stop", async () => {
      try {
        await sql?.end({ timeout: 5 });
      } catch (err) {
        api.logger.error(`twilio: error closing db: ${String(err)}`);
      }
    });
  },
};

export default twilioSmsPlugin;
