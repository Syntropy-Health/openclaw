/**
 * Kapso WhatsApp channel extension entry (B-Kapso-1, slice 3).
 *
 * Registers the `/kapso/whatsapp` inbound webhook: X-Hub-Signature-256 gate →
 * TCPA compliance-first → agent dispatch (replies go back out through the
 * opt-out-guarded Kapso send). Reuses the B-Twilio-1 durable opt-out store (one
 * opt-out keyspace across SMS + WhatsApp) and the shared compliance rails.
 *
 * The channel stays inert until credential-complete (resolveConfig → null → 503);
 * with no DATABASE_URL the opt-out store fails closed. Agent-INITIATED outbound
 * over the whatsapp channel (transport selection Baileys↔Kapso) is wired in the
 * core whatsapp channel behind the `transport` flag — a separate step, pending
 * the enum landing.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type OptOutStore } from "../../twilio/src/compliance.js";
import { asSqlTag, createSmsPgClient, type SmsPgClient } from "../../twilio/src/db.js";
import { createPgOptOutStore, ensureOptOutSchema } from "../../twilio/src/optout-store.js";
import { resolveKapsoConfig } from "./kapso-config.js";
import { handleKapsoInbound } from "./kapso-inbound.js";
import { resolveKapsoPhoneNumberId } from "./kapso-phone.js";
import { createKapsoWebhookHandler } from "./kapso-webhook.js";

/** Fail-closed store — throws on read so a missing DB suppresses all guarded sends. */
const FAIL_CLOSED_STORE: OptOutStore = {
  isOptedOut: () => {
    throw new Error("kapso opt-out store unavailable");
  },
  optOut: () => {},
  optIn: () => {},
};

const kapsoWhatsappPlugin = {
  id: "kapso",
  name: "WhatsApp (Kapso / Cloud API)",
  description:
    "WhatsApp transport via Kapso (Meta Cloud API): X-Hub-Signature-256 inbound webhook, TCPA opt-out rail.",

  async register(api: OpenClawPluginApi) {
    // Durable opt-out store — REUSE the B-Twilio-1 pg store (ADR 0001: OpenClaw's own DB).
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    let store: OptOutStore = FAIL_CLOSED_STORE;
    let sql: SmsPgClient | null = null;
    if (databaseUrl) {
      sql = createSmsPgClient(databaseUrl);
      try {
        await ensureOptOutSchema(asSqlTag(sql));
        store = createPgOptOutStore(asSqlTag(sql));
        api.logger.info("kapso: opt-out store ready (pg, shared with sms)");
      } catch (err) {
        api.logger.error(`kapso: opt-out schema init failed; sends fail-closed: ${String(err)}`);
      }
    } else {
      api.logger.warn("kapso: no DATABASE_URL — opt-out store unavailable; sends fail-closed");
    }

    // Phone-number-id: resolved once (explicit config value or derived from the WABA id), cached.
    let cachedPhoneNumberId: string | null = null;
    async function phoneNumberId(): Promise<string | null> {
      if (cachedPhoneNumberId) return cachedPhoneNumberId;
      const config = resolveKapsoConfig(undefined, process.env);
      if (!config) return null;
      cachedPhoneNumberId = await resolveKapsoPhoneNumberId(config);
      return cachedPhoneNumberId;
    }

    api.registerHttpRoute({
      path: "/kapso/whatsapp",
      handler: createKapsoWebhookHandler({
        resolveConfig: () => resolveKapsoConfig(undefined, process.env),
        onInbound: async (inbound) => {
          const config = resolveKapsoConfig(undefined, process.env);
          if (!config) return;
          const pnid = await phoneNumberId();
          if (!pnid) return; // no send target resolvable → drop (channel effectively inert)
          await handleKapsoInbound({
            inbound,
            cfg: api.config,
            config,
            phoneNumberId: pnid,
            store,
          });
        },
      }),
    });

    api.on("gateway_stop", async () => {
      try {
        await sql?.end({ timeout: 5 });
      } catch (err) {
        api.logger.error(`kapso: error closing db: ${String(err)}`);
      }
    });
  },
};

export default kapsoWhatsappPlugin;
