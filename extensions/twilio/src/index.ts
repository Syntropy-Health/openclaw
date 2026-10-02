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

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveSmsAccount } from "./accounts.js";
import { createSmsPlugin } from "./channel.js";
import { type OptOutStore } from "./compliance.js";
import {
  createPgContactStore,
  ensureContactSchema,
  type SmsContactStore,
} from "./contacts-store.js";
import { asSqlTag, createSmsPgClient, type SmsPgClient } from "./db.js";
import { handleInboundSms } from "./inbound.js";
import { createPgOptOutStore, ensureOptOutSchema } from "./optout-store.js";
import { smsGuardrailFor } from "./sms-guardrail.js";
import { createSmsWebhookHandler } from "./webhook.js";

/**
 * A store that throws on every read — used when no durable DB is available. Via
 * `guardedSendSms`'s fail-closed catch, this suppresses ALL agent sends: an
 * unprovable opt-out state must never let generated content through. (Mandated
 * compliance acks go via the unguarded path and are unaffected.)
 */
const FAIL_CLOSED_STORE: OptOutStore = {
  isOptedOut: () => {
    throw new Error("sms opt-out store unavailable");
  },
  optOut: () => {},
  optIn: () => {},
};

/** No first-contact record available: every lookup errors, which the inbound path
 * treats as "first" (send the opt-in confirmation — a duplicate beats a miss). */
const UNAVAILABLE_CONTACTS: SmsContactStore = {
  recordFirstContact: () => {
    throw new Error("sms first-contact store unavailable");
  },
  forgetContact: () => {},
  // No consent record reachable: agent-initiated sends are refused (fail closed).
  hasContact: () => false,
};

const twilioSmsPlugin = {
  id: "twilio",
  name: "SMS (Twilio)",
  description:
    "Two-way SMS via Twilio: outbound send, X-Twilio-Signature inbound webhook, TCPA opt-out rail.",

  async register(api: OpenClawPluginApi) {
    // ------------------------------------------------------------------
    // EXPLICIT-ENABLE, BY CONSTRUCTION — SYN-272 R1 [PRINCIPAL-RULED
    // 2026-08-27, cto-loop; recorded in CTO dispatch #7596 + SYN-272
    // Provenance]: "productionize the WhatsApp + SMS chat surfaces… This
    // SUPERSEDES the earlier SMS de-funding ruling."
    //
    // HISTORY, kept because the gate's shape came from it: #223 shipped
    // this gate under the 2026-08-21 de-funding ruling as
    // `enableDespiteSmsOutOfScopeRuling` — a labeled disable, not a
    // deletion, precisely so a supersession would be a RENAME and a
    // basis-comment rewrite instead of a rebuild. That day arrived
    // (2026-08-27); this is that rename. The anticipated ruling exists,
    // so the against-the-ruling WARN is now an INFO.
    //
    // WHY A FLAG AND NOT CREDENTIAL-ABSENCE (unchanged from #223, still
    // load-bearing): "inert until credential-complete" is inert BY
    // ACCIDENT — provision Twilio credentials for ANY unrelated reason
    // and an unowned transport activates. The flag makes both states BY
    // CONSTRUCTION: never inert-by-accident, never active-by-accident
    // (SYN-272 precondition 2). Strict equality: truthy strings/1 stay
    // disabled — fail-closed on sloppy config.
    //
    // GO-LIVE remains gated beyond this flag by the PVR's other arms:
    // the D0 sms row (R2), SJ's A7_CHANNELS (R3), TCPA consent record
    // (R5), and the behavioral pin in compliance.ts (a STOP'd number
    // receives zero further messages) — this flag funds the surface;
    // it does not skip the gates.
    // ------------------------------------------------------------------
    if (api.pluginConfig?.smsEnabled !== true) {
      api.logger.info(
        "twilio: SMS surface NOT ENABLED [SYN-272 R1: explicit-enable by construction] — " +
          "no channel, no webhook, regardless of credentials. Enable via " +
          "pluginConfig.smsEnabled: true (PVR channel-surfaces, P0).",
      );
      return;
    }
    api.logger.info(
      "twilio: smsEnabled — SMS surface ACTIVE under SYN-272 [PRINCIPAL-RULED 2026-08-27; " +
        "supersedes the 2026-08-21 de-funding ruling]. Go-live gates (D0 row, A7, TCPA " +
        "record, STOP pin) apply downstream.",
    );

    // Who sends STOP/HELP/START replies. Strict: only the exact string "twilio"
    // hands them to Twilio Advanced Opt-Out; anything else keeps ours, so a typo
    // can never leave a keyword unanswered.
    const keywordReplies: "openclaw" | "twilio" =
      api.pluginConfig?.keywordReplies === "twilio" ? "twilio" : "openclaw";
    api.logger.info(`twilio: keyword replies sent by ${keywordReplies}`);

    // Durable opt-out store — ADR 0001: OpenClaw's OWN Postgres (DATABASE_URL), never the Journal PHI DB.
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    let store: OptOutStore = FAIL_CLOSED_STORE;
    let contacts: SmsContactStore = UNAVAILABLE_CONTACTS;
    let sql: SmsPgClient | null = null;
    if (databaseUrl) {
      sql = createSmsPgClient(databaseUrl, { logger: api.logger, plugin: "twilio" });
      try {
        await ensureOptOutSchema(asSqlTag(sql));
        store = createPgOptOutStore(asSqlTag(sql));
        api.logger.info("twilio: opt-out store ready (pg)");
      } catch (err) {
        api.logger.error(
          `twilio: opt-out schema init failed; sends will fail-closed: ${String(err)}`,
        );
      }
      // Separate try: a contacts-table failure must not take the opt-out store down.
      try {
        await ensureContactSchema(asSqlTag(sql));
        contacts = createPgContactStore(asSqlTag(sql));
      } catch (err) {
        api.logger.error(
          `twilio: first-contact schema init failed; every message will re-send the opt-in confirmation: ${String(err)}`,
        );
      }
    } else {
      api.logger.warn(
        "twilio: no DATABASE_URL — opt-out store unavailable; sends fail-closed until provisioned",
      );
    }

    // Enabled but not credential-complete: the webhook refuses every message and
    // replies go nowhere. Say so at boot, naming what to provision (names only).
    const account = resolveSmsAccount(api.config);
    if (!account.configured) {
      api.logger.warn(
        `twilio: smsEnabled but SMS is INERT — missing ${account.missing.join(", ")}; ` +
          "inbound is refused and nothing is sent until these are set.",
      );
    }

    // No-medical-advice guardrail on every SMS turn (see sms-guardrail.ts for why this
    // is prependContext and not systemPrompt). High priority so it heads the context.
    api.on("before_agent_start", async (_event, ctx) => smsGuardrailFor(ctx), {
      priority: 250,
    });

    // Outbound channel.
    api.registerChannel({ plugin: createSmsPlugin({ store, contacts }) });

    // Inbound webhook: signature gate → compliance-first → agent.
    api.registerHttpRoute({
      path: "/twilio/sms",
      handler: createSmsWebhookHandler({
        resolveConfig: () => resolveSmsAccount(api.config).config,
        onInbound: async (inbound) => {
          const config = resolveSmsAccount(api.config).config;
          if (!config) return;
          // Compliance-first → access policy → agent (see inbound.ts).
          await handleInboundSms({
            inbound,
            cfg: api.config,
            config,
            store,
            contacts,
            logger: api.logger,
            keywordReplies,
          });
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
