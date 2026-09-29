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
 *  3. Mobile-originated opt-in: a number's first admitted non-keyword message IS its
 *     opt-in under the registered campaign, confirmed once with OPT_IN_REPLY before
 *     the agent answers. START records the number too, so the two never double up.
 *  4. Agent dispatch; the agent's generated reply IS opt-out-guarded.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { dispatchInboundMessageWithDispatcher } from "../../../src/auto-reply/dispatch.js";
import type { MsgContext } from "../../../src/auto-reply/templating.js";
import type { ReplyPayload } from "../../../src/auto-reply/types.js";
import { buildAgentPeerSessionKey, DEFAULT_AGENT_ID } from "../../../src/routing/session-key.js";
import { SMS_CHANNEL_ID } from "./accounts.js";
import {
  guardedSendSms,
  handleInboundCompliance,
  SMS_CAMPAIGN_COPY,
  type OptOutStore,
} from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { type SmsContactStore } from "./contacts-store.js";
import { sendSms, type SmsFetch } from "./send.js";
import { withShrineAiSignOff } from "./signoff.js";
import { type InboundSms } from "./webhook.js";

export type InboundOutcome = "stop" | "start" | "help" | "blocked" | "opted_out" | "agent";

/** Minimal logger for the rare failure paths (store errors). */
export type InboundLogger = { warn: (m: string) => void };

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
        // Every agent reply carries the ShrineAI identity (SMS has no sender
        // name) — THIS is the main conversational path (a user texted in).
        // The mandated STOP/START/HELP acks go through sendSms and stay unsigned.
        {
          config: params.config,
          to: params.to,
          body: withShrineAiSignOff(text),
          fetchImpl: params.fetchImpl,
        },
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
  /** First-contact record for mobile-originated opt-in (required: no silent skip). */
  contacts: SmsContactStore;
  logger?: InboundLogger;
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

/**
 * True iff this is the number's first confirmed contact. A store ERROR counts as
 * first: a duplicate opt-in confirmation is harmless, a missing one is a campaign
 * compliance gap. (The send itself stays opt-out-guarded either way.)
 */
async function isFirstContact(deps: HandleInboundDeps): Promise<boolean> {
  try {
    return await deps.contacts.recordFirstContact(deps.inbound.from);
  } catch (err) {
    deps.logger?.warn(
      `twilio: first-contact store failed; sending opt-in confirmation: ${String(err)}`,
    );
    return true;
  }
}

async function forgetContact(deps: HandleInboundDeps): Promise<void> {
  try {
    await deps.contacts.forgetContact(deps.inbound.from);
  } catch (err) {
    deps.logger?.warn(`twilio: could not clear an undelivered opt-in record: ${String(err)}`);
  }
}

async function optedOutOrUnknown(deps: HandleInboundDeps): Promise<boolean> {
  try {
    return await deps.store.isOptedOut(deps.inbound.from);
  } catch {
    return true;
  }
}

/** Compliance-first → policy → agent. Returns the branch taken (for tests/telemetry). */
export async function handleInboundSms(deps: HandleInboundDeps): Promise<InboundOutcome> {
  const { inbound, config, store, contacts } = deps;

  const outcome = await handleInboundCompliance(
    inbound.from,
    inbound.body,
    store,
    SMS_CAMPAIGN_COPY,
  );
  if (outcome.kind !== "passthrough") {
    // START sends OPT_IN_REPLY itself; record the number so a following ordinary
    // message does not confirm the opt-in a second time.
    if (outcome.kind === "start") await isFirstContact(deps);
    // UNGUARDED mandated ack — see module header.
    const ack = await sendSms({
      config,
      to: inbound.from,
      body: outcome.reply,
      fetchImpl: deps.fetchImpl,
    });
    // START's ack IS the opt-in confirmation: if it did not go out, forget the
    // record so the next message confirms instead of silently skipping it.
    if (outcome.kind === "start" && !ack.ok) await forgetContact(deps);
    return outcome.kind;
  }

  if (!inboundAllowed(config, inbound.from)) return "blocked";

  // An opted-out number gets no agent turn at all: every reply would be
  // suppressed anyway, so running the LLM is pure cost. Unknown (store error)
  // is treated the same — replies would fail closed too.
  if (await optedOutOrUnknown(deps)) return "opted_out";

  if (await isFirstContact(deps)) {
    // Opt-in confirmation (registered copy, unsigned). GUARDED, unlike the keyword
    // acks: this is not a reply to STOP.
    const sent = await guardedSendSms(
      { config, to: inbound.from, body: SMS_CAMPAIGN_COPY.start, fetchImpl: deps.fetchImpl },
      store,
    );
    // Recorded before sending (atomic dedupe); undo it if nothing was delivered,
    // so the next message confirms instead of the number never being confirmed.
    if (!sent.ok) await forgetContact(deps);
  }

  const dispatch = deps.dispatch ?? routeInboundToAgent;
  await dispatch({ inbound, cfg: deps.cfg, config, store, fetchImpl: deps.fetchImpl });
  return "agent";
}
