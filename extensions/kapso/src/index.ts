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

import {
  type ChannelOutboundTransport,
  normalizeE164,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk";
import { type OptOutStore } from "../../twilio/src/compliance.js";
import { asSqlTag, createSmsPgClient, type SmsPgClient } from "../../twilio/src/db.js";
import { createPgOptOutStore, ensureOptOutSchema } from "../../twilio/src/optout-store.js";
import { type ResolvedKapsoConfig, resolveKapsoConfig } from "./kapso-config.js";
import { handleKapsoInbound, type RouteKapsoParams } from "./kapso-inbound.js";
import { resolveKapsoPhoneNumberId } from "./kapso-phone.js";
import { sendKapsoMessage, type KapsoFetch } from "./kapso-send.js";
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

/** Sentinel messageId for a policy-suppressed (opted-out) proactive send. */
export const KAPSO_OUTBOUND_SUPPRESSED = "suppressed:optout";

/**
 * Resolve a WhatsApp outbound target to a canonical +E164 for the shared opt-out
 * + Cloud API keyspace. Strips the JID domain (…@s.whatsapp.net) AND any device
 * suffix (…:12@…) — normalizeE164 alone would fold the device digits into the
 * number. Returns null for group JIDs (…@g.us; the Cloud API can't send there)
 * and unparseable targets, so the guard never mis-keys the opt-out lookup on an
 * un-normalized caller input.
 */
export function whatsappTargetToE164(target: string): string | null {
  if (target.includes("@g.us")) return null;
  const user = target.split("@")[0]?.split(":")[0] ?? "";
  const e164 = normalizeE164(user);
  return e164 === "+" ? null : e164;
}

/**
 * The OUTBOUND transport send for the CORE whatsapp channel (B-Kapso slice 3b),
 * extracted so it is testable with an injected fetch (no network). The core
 * adapter invokes this ONLY when channels.whatsapp.transport === "kapso".
 * Proactive/agent-initiated sends are opt-out-GUARDED and fail-closed; WhatsApp
 * JIDs (…@s.whatsapp.net) are normalized to the shared +E164 keyspace.
 */
export function createKapsoOutboundTransport(deps: {
  resolveConfig: () => ResolvedKapsoConfig | null;
  resolvePhoneNumberId: () => Promise<string | null>;
  store: OptOutStore;
  logger?: KapsoLogger;
  fetchImpl?: KapsoFetch;
}): ChannelOutboundTransport {
  return async (ctx) => {
    const config = deps.resolveConfig();
    if (!config) throw new Error("kapso transport: config unavailable (credentials incomplete)");
    const phoneNumberId = await deps.resolvePhoneNumberId();
    if (!phoneNumberId) throw new Error("kapso transport: phone-number-id unresolved");
    const to = whatsappTargetToE164(ctx.to);
    if (!to) {
      throw new Error(`kapso transport: unsupported target "${ctx.to}" (group JID or invalid)`);
    }
    let optedOut: boolean;
    try {
      optedOut = await deps.store.isOptedOut(to);
    } catch {
      throw new Error("kapso transport: opt-out store unavailable — fail-closed (no send)");
    }
    if (optedOut) {
      deps.logger?.warn?.("kapso transport: proactive send suppressed — recipient opted out");
      return {
        channel: "whatsapp",
        messageId: KAPSO_OUTBOUND_SUPPRESSED,
        toJid: ctx.to,
        meta: { transport: "kapso", suppressed: true },
      };
    }
    const r = await sendKapsoMessage({
      config,
      phoneNumberId,
      to,
      body: ctx.text,
      fetchImpl: deps.fetchImpl,
    });
    if (!r.ok) {
      throw new Error(`kapso transport send failed (status ${r.status ?? "n/a"}): ${r.error}`);
    }
    return { channel: "whatsapp", messageId: r.sid, toJid: ctx.to, meta: { transport: "kapso" } };
  };
}

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
    // QG M3 gate (slice 3b): don't drive inbound unless Kapso is the SELECTED
    // whatsapp transport — otherwise Kapso creds + an active Baileys transport
    // could both process the same `whatsapp` session namespace. Kapso's webhook
    // only receives inbound when Meta routes to it (i.e. when it's the transport),
    // but this is defense-in-depth against a mis-provisioned dual-live state.
    // NOTE: reads the register-time config snapshot — a `transport` flip requires a
    // gateway restart (the slice-4 cutover is a deploy, so this is acceptable). The
    // OUTBOUND side reads live per-send ctx.cfg; both key on the same field.
    if (deps.cfg.channels?.whatsapp?.transport !== "kapso") {
      deps.logger?.info?.("kapso: inbound skipped — whatsapp transport is not 'kapso'");
      return;
    }
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
      // createSmsPgClient is INSIDE the try (QG): a malformed DATABASE_URL that
      // throws here must leave the fail-closed store in place and NOT abort
      // register() before the outbound transport is registered — otherwise a
      // selected `transport: "kapso"` would fail-open to unguarded Baileys.
      try {
        sql = createSmsPgClient(databaseUrl);
        await ensureOptOutSchema(asSqlTag(sql));
        store = createPgOptOutStore(asSqlTag(sql));
        api.logger.info("kapso: opt-out store ready (pg, shared with sms)");
      } catch (err) {
        api.logger.error(`kapso: opt-out store init failed; sends fail-closed: ${String(err)}`);
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

    // B-Kapso slice 3b — OUTBOUND transport: register the Kapso send for the CORE
    // whatsapp channel. The core outbound adapter calls this ONLY when
    // channels.whatsapp.transport === "kapso" (default baileys → never reached).
    // Proactive/agent-initiated sends are opt-out-GUARDED (a STOP'd number must
    // never receive a proactive WhatsApp message — TCPA); fail-closed if the store
    // is down. WhatsApp targets are JIDs (…@s.whatsapp.net) → normalized to +E164
    // (the shared opt-out + Cloud API keyspace).
    api.registerChannelTransport({
      channel: "whatsapp",
      transport: "kapso",
      send: createKapsoOutboundTransport({
        resolveConfig: () => resolveKapsoConfig(undefined, process.env),
        resolvePhoneNumberId: phoneNumberId,
        store,
        logger: api.logger,
      }),
    });

    // QG M3 (coupling) — INBOUND gate mirrors the outbound selection: createKapsoOnInbound
    // short-circuits unless channels.whatsapp.transport === "kapso", so Kapso creds + an
    // active Baileys transport can't both drive inbound on the same `whatsapp` session
    // namespace. Active as of slice 3b (the enum now exists).
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
