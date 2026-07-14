/**
 * SMS outbound adapter (B-Twilio-1, slice 5b) — maps the send primitive to the
 * channel `ChannelOutboundAdapter.sendText` contract.
 *
 * Delivery-queue semantics (src/infra/outbound/deliver.ts): a RETURNED result
 * is terminal (ackDelivery), a THROWN error is a failure (failDelivery →
 * retry). We use that deliberately:
 *  - Opt-out SUPPRESSION → return a terminal sentinel result. A STOP'd
 *    recipient must NEVER re-enter the retry queue (the TCPA rail, slice 4).
 *  - A genuine transient send failure → THROW (retryable).
 *
 * Config + opt-out store + fetch are all injected so this stays a pure,
 * testable mapping with no OpenClawConfig/DB/network coupling of its own.
 */

import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { guardedSendSms, type OptOutStore } from "./compliance.js";
import { type ResolvedTwilioSmsConfig } from "./config.js";
import { type SmsFetch } from "./send.js";

/** Sentinel messageId for an opt-out-suppressed (terminal, unsent) delivery. */
export const SMS_OPTOUT_SUPPRESSED = "suppressed:optout";

export type SmsOutboundDeps = {
  /** Resolve the credential-complete SMS config from the live OpenClawConfig (null → inert). */
  resolveConfig: (cfg: OpenClawConfig) => ResolvedTwilioSmsConfig | null;
  store: OptOutStore;
  /** Test seam; defaults to global fetch inside sendSms. */
  fetchImpl?: SmsFetch;
};

export function buildSmsOutboundAdapter(deps: SmsOutboundDeps): ChannelOutboundAdapter {
  return {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const config = deps.resolveConfig(ctx.cfg);
      if (!config) throw new Error("sms channel is not configured");

      const result = await guardedSendSms(
        { config, to: ctx.to, body: ctx.text, fetchImpl: deps.fetchImpl },
        deps.store,
      );

      if ("suppressed" in result) {
        // Terminal + non-retryable: the opt-out rail short-circuited the send.
        return { channel: "sms", messageId: SMS_OPTOUT_SUPPRESSED, meta: { suppressed: true } };
      }
      if (!result.ok) {
        // Throw → deliver.ts failDelivery → retry. The api-key secret is never
        // part of `result.error` (send.ts secret hygiene), so this is safe.
        const code = result.status !== null ? ` (${result.status})` : "";
        throw new Error(`sms send failed${code}: ${result.error}`);
      }
      return {
        channel: "sms",
        messageId: result.sid,
        ...(result.status ? { meta: { status: result.status } } : {}),
      };
    },
  };
}
