/**
 * Composed inbound SMS handling (B-Twilio-1, slice 5d — QG remediation).
 *
 * Extracted from `index.ts`'s inline `register()` closures so the compliance-
 * first ordering, the mandated-ack send, and the access policy are unit-testable
 * (mirrors how `decideInboundSms` was extracted from the webhook handler).
 *
 * Order is load-bearing:
 *  1. TCPA compliance keywords (STOP/START/HELP) are handled BEFORE the agent
 *     and BEFORE the access policy — a STOP must be honored from ANY number. The
 *     ack is sent via the UNGUARDED `sendSms`: a legally-required opt-out/HELP
 *     reply must reach the recipient even though STOP just recorded their opt-out
 *     (guarded send would suppress it — the bug this remediation fixes).
 *  2. Inbound access policy (`disabled`/`allowlist`/`pairing`) gates ordinary
 *     messages only.
 *  3. Agent dispatch; the agent's generated reply IS opt-out-guarded.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { dispatchInboundMessageWithDispatcher } from "../../../src/auto-reply/dispatch.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { buildAgentPeerSessionKey, DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { SMS_CHANNEL_ID } from "./accounts.js";
import { guardedSendSms, handleInboundCompliance, type OptOutStore } from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { sendSms, type SmsFetch } from "./send.js";
import { type InboundSms } from "./webhook.js";

export type InboundOutcome = "stop" | "start" | "help" | "blocked" | "agent";

/**
 * Inbound access policy — applied to PASSTHROUGH messages only (compliance
 * keywords are honored first). `disabled` drops all; `allowlist` admits only
 * `allowFrom`; `pairing` admits everything (downstream connect-gate handles the
 * unpaired). Fixes the "declared-but-unenforced control" gap.
 */
export function inboundAllowed(config: ResolvedTwilioSmsConfig, from: string): boolean {
  switch (config.inbound) {
    case "disabled":
      return false;
    case "allowlist":
      return config.allowFrom.includes(from);
    case "pairing":
      return true;
  }
}

/** The agent-reply deliverer — generated content goes through the opt-out-guarded send. */
export function createSmsReplyDeliver(params: {
  config: ResolvedTwilioSmsConfig;
  to: string;
  store: OptOutStore;
  fetchImpl?: SmsFetch;
}) {
  return async (payload: ReplyPayload): Promise<void> => {
    const text = payload.text?.trim();
    if (text) {
      await guardedSendSms(
        { config: params.config, to: params.to, body: text, fetchImpl: params.fetchImpl },
        params.store,
      );
    }
  };
}

/** Build the inbound context + dispatch a real (non-compliance) SMS to the agent. */
export async function routeInboundToAgent(params: {
  inbound: InboundSms;
  cfg: OpenClawConfig;
  config: ResolvedTwilioSmsConfig;
  store: OptOutStore;
  fetchImpl?: SmsFetch;
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
      deliver: createSmsReplyDeliver({
        config,
        to: inbound.from,
        store,
        fetchImpl: params.fetchImpl,
      }),
    },
  });
}

export type HandleInboundDeps = {
  inbound: InboundSms;
  cfg: OpenClawConfig;
  config: ResolvedTwilioSmsConfig;
  store: OptOutStore;
  fetchImpl?: SmsFetch;
  /** Agent-routing seam (default {@link routeInboundToAgent}); injectable for tests. */
  dispatch?: (params: {
    inbound: InboundSms;
    cfg: OpenClawConfig;
    config: ResolvedTwilioSmsConfig;
    store: OptOutStore;
    fetchImpl?: SmsFetch;
  }) => Promise<void>;
};

/** Compliance-first → policy → agent. Returns the branch taken (for tests/telemetry). */
export async function handleInboundSms(deps: HandleInboundDeps): Promise<InboundOutcome> {
  const { inbound, config, store } = deps;

  const outcome = await handleInboundCompliance(inbound.from, inbound.body, store);
  if (outcome.kind !== "passthrough") {
    // UNGUARDED mandated ack — see module header.
    await sendSms({ config, to: inbound.from, body: outcome.reply, fetchImpl: deps.fetchImpl });
    return outcome.kind;
  }

  if (!inboundAllowed(config, inbound.from)) return "blocked";

  const dispatch = deps.dispatch ?? routeInboundToAgent;
  await dispatch({ inbound, cfg: deps.cfg, config, store, fetchImpl: deps.fetchImpl });
  return "agent";
}
