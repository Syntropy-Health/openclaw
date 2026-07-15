/**
 * SMS ChannelPlugin object (B-Twilio-1, slice 5d).
 *
 * Assembles the tested building blocks into the `ChannelPlugin` the gateway
 * registers: the config adapter (5a), the outbound adapter (5b, opt-out-guarded).
 * The channel id is vendor-agnostic `"sms"` — Twilio is only the transport, so
 * WhatsApp can reuse the same channel surface in B-Twilio-2.
 *
 * Built by a factory (not a static export like irc) because the outbound adapter
 * closes over the durable opt-out store resolved at `register()` time.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import {
  resolveSmsAccount,
  smsConfigAdapter,
  SMS_CHANNEL_ID,
  type ResolvedSmsAccount,
} from "./accounts.js";
import { type OptOutStore } from "./compliance.js";
import { buildSmsOutboundAdapter } from "./outbound.js";
import { type SmsFetch } from "./send.js";

const meta = {
  id: SMS_CHANNEL_ID,
  label: "SMS",
  selectionLabel: "SMS (Twilio)",
  docsPath: "/channels/sms",
  blurb: "Two-way SMS via Twilio. Nudge/CTA/nav only — PHI stays in-app.",
};

export type SmsPluginDeps = {
  store: OptOutStore;
  /** Test seam threaded to the outbound sender. */
  fetchImpl?: SmsFetch;
};

export function createSmsPlugin(deps: SmsPluginDeps): ChannelPlugin<ResolvedSmsAccount> {
  return {
    id: SMS_CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      reply: false,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.sms"] },
    config: smsConfigAdapter,
    outbound: buildSmsOutboundAdapter({
      resolveConfig: (cfg) => resolveSmsAccount(cfg).config,
      store: deps.store,
      fetchImpl: deps.fetchImpl,
    }),
  };
}
