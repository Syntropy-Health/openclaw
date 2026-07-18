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
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { dispatchInboundMessageWithDispatcher } from "../../../src/auto-reply/dispatch.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { buildAgentPeerSessionKey, DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { handleInboundCompliance, type OptOutStore } from "../../twilio/src/compliance.js";
import { type ResolvedKapsoConfig } from "./kapso-config.js";
import { sendKapsoMessage, type KapsoFetch } from "./kapso-send.js";
import { type KapsoInbound } from "./kapso-webhook.js";

const WHATSAPP_CHANNEL_ID = "whatsapp";

export type KapsoInboundOutcome = "stop" | "start" | "help" | "blocked" | "agent";

/** Access policy for passthrough messages (compliance keywords are honored first). */
export function kapsoInboundAllowed(config: ResolvedKapsoConfig, from: string): boolean {
  switch (config.inbound) {
    case "disabled":
      return false;
    case "allowlist":
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
  return { ok: r.ok };
}

/** Agent-reply deliverer — generated content goes through the opt-out-guarded send. */
export function createKapsoReplyDeliver(params: {
  config: ResolvedKapsoConfig;
  phoneNumberId: string;
  to: string;
  store: OptOutStore;
  fetchImpl?: KapsoFetch;
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
      }),
    },
  });
}

export type HandleKapsoInboundDeps = RouteKapsoParams & {
  dispatch?: (params: RouteKapsoParams) => Promise<void>;
};

/** Compliance-first → policy → agent. Returns the branch taken. */
export async function handleKapsoInbound(
  deps: HandleKapsoInboundDeps,
): Promise<KapsoInboundOutcome> {
  const outcome = await handleInboundCompliance(deps.inbound.from, deps.inbound.body, deps.store);
  if (outcome.kind !== "passthrough") {
    // UNGUARDED mandated ack — must reach the recipient despite a just-recorded opt-out.
    await sendKapsoMessage({
      config: deps.config,
      phoneNumberId: deps.phoneNumberId,
      to: deps.inbound.from,
      body: outcome.reply,
      fetchImpl: deps.fetchImpl,
    });
    return outcome.kind;
  }

  if (!kapsoInboundAllowed(deps.config, deps.inbound.from)) return "blocked";

  const dispatch = deps.dispatch ?? routeKapsoInboundToAgent;
  await dispatch({
    inbound: deps.inbound,
    cfg: deps.cfg,
    config: deps.config,
    phoneNumberId: deps.phoneNumberId,
    store: deps.store,
    fetchImpl: deps.fetchImpl,
  });
  return "agent";
}
