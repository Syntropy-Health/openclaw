/**
 * Composed Kapso inbound handling (B-Kapso-1, slice 3).
 *
 * Same load-bearing order + TCPA semantics as the SMS path, with the Kapso Cloud
 * API send: (1) compliance keywords handled BEFORE the agent, ack sent via the
 * UNGUARDED send (a STOP confirmation / HELP copy must reach the recipient even
 * though STOP just opted them out); (2) inbound access policy for ordinary
 * messages; (3) agent dispatch, whose generated reply IS opt-out-guarded.
 *
 * The compliance classifier + the durable opt-out store are REUSED from the
 * B-Twilio-1 rails (one opt-out keyspace across SMS + WhatsApp — a STOP on either
 * channel opts out the same E.164). Only the send is Kapso-specific.
 *
 * Compliance recording (opt-out/opt-in persistence) happens inside
 * `handleInboundCompliance` and is NEVER gated on send-target resolution: a STOP
 * is recorded even when the sender phone-number-id is unresolved (QG M4) — we
 * only skip the ack SEND in that case. Send failures are logged, never swallowed
 * (QG M2); the logged text carries the HTTP status but never a secret (the send
 * scrubs its error text of the api key).
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { dispatchInboundMessageWithDispatcher } from "../../../src/auto-reply/dispatch.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { buildAgentPeerSessionKey, DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { handleInboundCompliance, type OptOutStore } from "../../twilio/src/compliance.js";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { sendKapsoMessage, type KapsoFetch } from "./kapso-send.js";
import { type KapsoInbound, type KapsoLogger } from "./kapso-webhook.js";

const WHATSAPP_CHANNEL_ID = "whatsapp";

export type KapsoInboundOutcome = "stop" | "start" | "help" | "blocked" | "agent";

/** Access policy for passthrough messages (compliance keywords are honored first). */
export function kapsoInboundAllowed(config: ResolvedKapsoConfig, from: string): boolean {
  switch (config.inbound) {
    case "disabled":
      return false;
    case "allowlist":
      // `from` is canonical +E164 (normalized at the webhook parse boundary) and
      // allowFrom entries are +E164-validated — so this compares like-for-like.
      return config.allowFrom.includes(from);
    case "pairing":
      return true;
  }
}

export type SuppressedSend = { ok: false; suppressed: true };

/** Send a Kapso message ONLY if the peer hasn't opted out — fail-closed on store error. */
export async function guardedSendKapso(params: {
  config: ResolvedKapsoConfig;
  phoneNumberId: string;
  to: string;
  body: string;
  store: OptOutStore;
  fetchImpl?: KapsoFetch;
  logger?: KapsoLogger;
}): Promise<{ ok: boolean } | SuppressedSend> {
  let optedOut: boolean;
  try {
    optedOut = await params.store.isOptedOut(params.to);
  } catch {
    return { ok: false, suppressed: true };
  }
  if (optedOut) return { ok: false, suppressed: true };
  const r = await sendKapsoMessage({
    config: params.config,
    phoneNumberId: params.phoneNumberId,
    to: params.to,
    body: params.body,
    fetchImpl: params.fetchImpl,
  });
  if (!r.ok) {
    // QG M2: never swallow a send failure. Status only — the send guarantees its
    // error text carries no api key.
    params.logger?.warn?.(
      `kapso: agent-reply send failed (status ${r.status ?? "n/a"}): ${r.error}`,
    );
  }
  return { ok: r.ok };
}

/** Agent-reply deliverer — generated content goes through the opt-out-guarded send. */
export function createKapsoReplyDeliver(params: {
  config: ResolvedKapsoConfig;
  phoneNumberId: string;
  to: string;
  store: OptOutStore;
  fetchImpl?: KapsoFetch;
  logger?: KapsoLogger;
}) {
  return async (payload: ReplyPayload): Promise<void> => {
    const text = payload.text?.trim();
    if (text) await guardedSendKapso({ ...params, body: text });
  };
}

export type RouteKapsoParams = {
  inbound: KapsoInbound;
  cfg: OpenClawConfig;
  config: ResolvedKapsoConfig;
  phoneNumberId: string;
  store: OptOutStore;
  fetchImpl?: KapsoFetch;
  logger?: KapsoLogger;
};

export async function routeKapsoInboundToAgent(params: RouteKapsoParams): Promise<void> {
  const sessionKey = buildAgentPeerSessionKey({
    agentId: DEFAULT_AGENT_ID,
    channel: WHATSAPP_CHANNEL_ID,
    peerKind: "direct",
    peerId: params.inbound.from,
    dmScope: "per-channel-peer",
  });
  const ctx: MsgContext = {
    Body: params.inbound.body,
    From: params.inbound.from,
    SessionKey: sessionKey,
    Provider: WHATSAPP_CHANNEL_ID,
    Surface: WHATSAPP_CHANNEL_ID,
    ChatType: "direct",
  };
  await dispatchInboundMessageWithDispatcher({
    ctx,
    cfg: params.cfg,
    dispatcherOptions: {
      deliver: createKapsoReplyDeliver({
        config: params.config,
        phoneNumberId: params.phoneNumberId,
        to: params.inbound.from,
        store: params.store,
        fetchImpl: params.fetchImpl,
        logger: params.logger,
      }),
    },
  });
}

export type HandleKapsoInboundDeps = {
  inbound: KapsoInbound;
  cfg: OpenClawConfig;
  config: ResolvedKapsoConfig;
  /**
   * Resolved sender phone-number-id, or null when it could not be derived.
   * Compliance is still recorded when null (QG M4); only the SEND is skipped.
   */
  phoneNumberId: string | null;
  store: OptOutStore;
  fetchImpl?: KapsoFetch;
  logger?: KapsoLogger;
  dispatch?: (params: RouteKapsoParams) => Promise<void>;
};

/** Compliance-first → policy → agent. Returns the branch taken. */
export async function handleKapsoInbound(
  deps: HandleKapsoInboundDeps,
): Promise<KapsoInboundOutcome> {
  // Compliance runs (and PERSISTS opt-out/opt-in) before anything else — including
  // before send-target resolution. A STOP is recorded even if we can't ack it.
  const outcome = await handleInboundCompliance(deps.inbound.from, deps.inbound.body, deps.store);
  if (outcome.kind !== "passthrough") {
    if (deps.phoneNumberId) {
      // UNGUARDED mandated ack — must reach the recipient despite a just-recorded opt-out.
      const r = await sendKapsoMessage({
        config: deps.config,
        phoneNumberId: deps.phoneNumberId,
        to: deps.inbound.from,
        body: outcome.reply,
        fetchImpl: deps.fetchImpl,
      });
      if (!r.ok) {
        // QG M2: the mandated STOP/HELP/START ack failing is operationally important — log it.
        deps.logger?.error?.(
          `kapso: mandated '${outcome.kind}' compliance ack send failed (status ${r.status ?? "n/a"}): ${r.error}`,
        );
      }
    } else {
      // QG M4: opt-out already recorded; we simply cannot send the ack right now.
      deps.logger?.warn?.(
        `kapso: '${outcome.kind}' compliance recorded but ack NOT sent — phone-number-id unresolved`,
      );
    }
    return outcome.kind;
  }

  if (!kapsoInboundAllowed(deps.config, deps.inbound.from)) return "blocked";

  if (!deps.phoneNumberId) {
    // No sender resolvable → an agent reply could never be delivered; don't run it.
    deps.logger?.warn?.(
      "kapso: inbound allowed but phone-number-id unresolved — agent dispatch skipped",
    );
    return "blocked";
  }

  const dispatch = deps.dispatch ?? routeKapsoInboundToAgent;
  try {
    await dispatch({
      inbound: deps.inbound,
      cfg: deps.cfg,
      config: deps.config,
      phoneNumberId: deps.phoneNumberId,
      store: deps.store,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
    });
  } catch (err) {
    // Agent dispatch is NOT compliance-critical: swallow-and-log so the webhook
    // still 200s (a poison message must not drive infinite Meta redelivery). Only
    // the compliance-store write above is allowed to propagate → webhook 5xx/retry.
    deps.logger?.error?.(`kapso: agent dispatch failed: ${String(err)}`);
  }
  return "agent";
}
