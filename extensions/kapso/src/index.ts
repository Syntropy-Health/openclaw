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

import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type OptOutStore } from "../../twilio/src/compliance.js";
import { asSqlTag, createSmsPgClient, type SmsPgClient } from "../../twilio/src/db.js";
import { createPgOptOutStore, ensureOptOutSchema } from "../../twilio/src/optout-store.js";
import { type ResolvedKapsoConfig, resolveKapsoConfig } from "./kapso-config.js";
import { handleKapsoInbound, type RouteKapsoParams } from "./kapso-inbound.js";
import { resolveKapsoPhoneNumberId } from "./kapso-phone.js";
import { type KapsoFetch } from "./kapso-send.js";
import { createKapsoWebhookHandler, type KapsoInbound, type KapsoLogger } from "./kapso-webhook.js";

/**
 * Fail-closed store — throws on READ so a missing DB suppresses all guarded sends.
 * The writes are no-ops (there is nowhere to persist), but they LOG so a dropped
 * compliance write is observable rather than silent (review finding). Safe in
 * aggregate only because the throwing read suppresses every send fail-closed.
 */
export function makeFailClosedStore(logger?: KapsoLogger): OptOutStore {
  return {
    isOptedOut: () => {
      throw new Error("kapso opt-out store unavailable");
    },
    optOut: () =>
      logger?.error?.("kapso: opt-out NOT persisted — store unavailable (no DATABASE_URL)"),
    optIn: () =>
      logger?.warn?.("kapso: opt-in NOT persisted — store unavailable (no DATABASE_URL)"),
  };
}

/** No-logger fail-closed store — the throwing-read contract the guarded send relies on. */
export const FAIL_CLOSED_STORE: OptOutStore = makeFailClosedStore();

/**
 * The `onInbound` composition, extracted so the QG-M4 wiring (a null
 * phone-number-id must NOT early-return before compliance) is directly testable
 * without a live gateway. Resolves config + send-target per message, then hands
 * off to the compliance-first handler.
 */
export function createKapsoOnInbound(deps: {
  resolveConfig: () => ResolvedKapsoConfig | null;
  resolvePhoneNumberId: () => Promise<string | null>;
  store: OptOutStore;
  cfg: OpenClawConfig;
  logger?: KapsoLogger;
  fetchImpl?: KapsoFetch;
  dispatch?: (params: RouteKapsoParams) => Promise<void>;
}): (inbound: KapsoInbound) => Promise<void> {
  return async (inbound) => {
    const config = deps.resolveConfig();
    if (!config) return;
    // QG M4: resolve the send target but DO NOT early-return on null — a null
    // phone-number-id must not drop a STOP. handleKapsoInbound records compliance
    // regardless and only skips the (unsendable) ack.
    const phoneNumberId = await deps.resolvePhoneNumberId();
    await handleKapsoInbound({
      inbound,
      cfg: deps.cfg,
      config,
      phoneNumberId,
      store: deps.store,
      logger: deps.logger,
      fetchImpl: deps.fetchImpl,
      dispatch: deps.dispatch,
    });
  };
}

const kapsoWhatsappPlugin = {
  id: "kapso",
  name: "WhatsApp (Kapso / Cloud API)",
  description:
    "WhatsApp transport via Kapso (Meta Cloud API): X-Hub-Signature-256 inbound webhook, TCPA opt-out rail.",

  async register(api: OpenClawPluginApi) {
    // Durable opt-out store — REUSE the B-Twilio-1 pg store (ADR 0001: OpenClaw's own DB).
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    let store: OptOutStore = makeFailClosedStore(api.logger);
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

    // QG M3 (coupling — deferred to slice-3b, B-Kapso slice 3b): once the `transport`
    // enum lands on the CORE whatsapp channel, the onInbound composition must
    // short-circuit unless transport==="kapso", so Kapso creds + an active
    // Baileys/WABA transport can't both drive inbound on the same `whatsapp` session
    // namespace. The core whatsapp transport-selection site (where the enum is read)
    // MUST mirror this gate. Latent today (enum not yet on main); credential-presence
    // is the only gate for now.
    api.registerHttpRoute({
      path: "/kapso/whatsapp",
      handler: createKapsoWebhookHandler({
        resolveConfig: () => resolveKapsoConfig(undefined, process.env),
        logger: api.logger,
        onInbound: createKapsoOnInbound({
          resolveConfig: () => resolveKapsoConfig(undefined, process.env),
          resolvePhoneNumberId: phoneNumberId,
          store,
          cfg: api.config,
          logger: api.logger,
        }),
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
