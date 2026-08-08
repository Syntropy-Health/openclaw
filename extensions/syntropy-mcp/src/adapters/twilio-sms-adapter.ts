/**
 * Twilio SMS channel adapter (Phase 7.2) — the REFERENCE thin adapter over the C0
 * seam.
 *
 * "Thin" is the whole point. An adapter contributes exactly two things and nothing
 * else:
 *   (a) how this provider names an INBOUND sender  → {@link ChannelAdapter.identity}
 *   (b) how this provider physically SENDS bytes   → the two sinks handed to
 *       {@link deliverViaCapabilities}
 * Everything else — which route a payload takes, what a failure looks like, when to
 * fail closed — is declared data (the D0 row) resolved once by the shared resolver
 * in channel-adapter.ts. An adapter that adds a routing `if` has re-opened the
 * atomicity seam and made the core channel-aware again.
 *
 * Consequently this file contains NO branch on payload kind for routing purposes;
 * the only `switch` here maps a payload to its literal wire text.
 *
 * SMS's D0 row is `inline_link:true, inline_text:true`, so in practice every
 * payload routes inline and the companion sink is unreachable for this channel.
 * The companion sink is still supplied — correctly, not as a stub — because the
 * capability table is the authority on reachability, not this file. If the row ever
 * changed, the adapter would keep working rather than silently dropping.
 *
 * Sending goes through {@link guardedSendSms}, NEVER the raw `sendSms`: the TCPA
 * opt-out rail is a hard legal requirement, and a channel adapter is exactly the
 * kind of new call site that would otherwise bypass it.
 */

import { normalizeE164 } from "openclaw/plugin-sdk";
import { guardedSendSms, type OptOutStore } from "../../../twilio/src/compliance.js";
import type { ResolvedTwilioSmsConfig } from "../../../twilio/src/config.js";
import type { SmsFetch } from "../../../twilio/src/transport.js";
import {
  type ChannelAdapter,
  type ChannelIdentity,
  type DeliveryPayload,
  type DeliveryResult,
  deliverViaCapabilities,
} from "../channel-adapter.js";
import { capabilitiesFor } from "../channel-capability-config.js";
import type { AdapterSession } from "./session.js";

/**
 * The D0 lookup key AND the `channelId` reported by `identity()` — deliberately
 * the same constant. `ChannelIdentity.channelId` is the channel KIND, which is
 * precisely the key the core hands back to `capabilitiesFor`; letting the two
 * drift apart would let an identity resolve to a different row than the adapter
 * that produced it.
 */
const SMS_CHANNEL_KIND = "sms";

/**
 * The Twilio inbound-webhook form field carrying the sender's number. Twilio posts
 * `application/x-www-form-urlencoded`, so the caller hands us the parsed body as
 * `URLSearchParams` rather than a provider-specific object.
 */
const TWILIO_FROM_PARAM = "From";

/**
 * `normalizeE164` is total — it never throws and never returns null. A completely
 * non-numeric input therefore collapses to this bare "+" rather than failing, which
 * would sail straight through a truthiness check and bind a session to a garbage
 * identity. Every caller must reject it explicitly; the shipped kapso webhook
 * parser carries the identical guard.
 */
const DEGENERATE_E164 = "+";

export type TwilioSmsAdapterDeps = {
  /** Per-session destination binding. For SMS only `toE164` is meaningful. */
  session: AdapterSession;
  /** Credential-complete Twilio SMS config (already fail-closed at resolution). */
  config: ResolvedTwilioSmsConfig;
  /** Durable TCPA opt-out store consulted before every send. */
  store: OptOutStore;
  /** Injected transport — the test seam; defaults to global `fetch` downstream. */
  fetchImpl?: SmsFetch;
};

/**
 * The literal wire text for a payload.
 *
 * Deliberately verbatim: the text, the URL, or the code — no greeting, no framing
 * copy, no explanation of what the recipient is being sent. Per R6/R7 an outbound
 * channel payload is identifier-only; any prose added here is prose that has not
 * been through render-policy and is a PHI-leak surface by construction. Adding
 * marketing copy would additionally re-open the TCPA content question this rail
 * exists to close.
 */
function bodyFor(payload: DeliveryPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.text;
    case "link":
      return payload.url;
    case "otp":
      return payload.code;
  }
}

/**
 * Build a sink: send `payload` to `to` through the opt-out-guarded SMS path and
 * report delivered-or-not as a plain boolean.
 *
 * A sink MUST NOT throw (contract §4.3). The resolver awaits it to decide `ok`,
 * and a throw escaping here would escape `deliver()` entirely — turning a routine
 * provider hiccup into an exception the channel-agnostic core would have to catch,
 * and destroying the `via` information that says which route was actually
 * attempted. So both failure shapes are flattened to `false`:
 *
 *  - a returned failure — `{ok:false}` from the transport, or a `SuppressedSend`
 *    from the opt-out rail. Suppression is a REAL non-delivery: the recipient sent
 *    STOP (or the store was unreadable and the rail failed closed) and no message
 *    went out, so reporting `true` would be a lie that hides a TCPA-relevant event.
 *  - a REJECTED promise. `guardedSendSms` is documented to return rather than
 *    throw, but it is not ours and `store.isOptedOut` may be async — a synchronous
 *    throw before the store read, or any future change downstream, must not be able
 *    to breach the seam. This catch is the belt to that suspenders, not dead code.
 */
function makeGuardedSink(deps: TwilioSmsAdapterDeps) {
  return async function send(to: string, payload: DeliveryPayload): Promise<boolean> {
    try {
      const result = await guardedSendSms(
        {
          config: deps.config,
          to,
          body: bodyFor(payload),
          fetchImpl: deps.fetchImpl,
        },
        deps.store,
      );
      // `ok` is false for BOTH a transport failure and a suppressed send; neither
      // put a message on the wire, so neither is a delivery.
      return result.ok;
    } catch {
      // Never let a provider/store fault escape the sink — see the doc above.
      return false;
    }
  };
}

/**
 * Read the inbound sender from a Twilio SMS webhook body and normalize it.
 *
 * FAIL CLOSED BY THROWING. `ChannelIdentity` is non-nullable, so there is no
 * in-band way to say "I could not identify this sender" — the only honest options
 * are to throw or to fabricate an identity, and fabricating one would bind an
 * authenticated session to an attacker-chosen or empty peer. Three distinct
 * rejections, all of which produce a plausible-looking-but-wrong identity if left
 * unguarded:
 *
 *  1. not `URLSearchParams` — a JSON body, a null, a hand-rolled object. Anything
 *     with a `.get` would otherwise duck-type its way in.
 *  2. missing or blank `From` — an empty string normalizes to the degenerate "+".
 *  3. a non-digit `From` that collapses to the degenerate "+" — see
 *     {@link DEGENERATE_E164}.
 *
 * The inbound argument is only READ (`URLSearchParams.get`), never mutated: callers
 * hand us the request body and may still need it (signature re-verification,
 * logging). Error messages deliberately omit the offending value — a phone number
 * is an identifier and must not land in logs via a thrown message.
 *
 * The native per-conversation id (`MessageSid`) is never read and never surfaced.
 * The core resolves capabilities by KIND; a native id in the identity would be a
 * channel-specific detail leaking through the seam.
 */
function identityFromTwilioForm(inbound: unknown): ChannelIdentity {
  if (!(inbound instanceof URLSearchParams)) {
    throw new Error(
      "twilio-sms adapter: inbound must be URLSearchParams (Twilio webhook form body)",
    );
  }

  const from = inbound.get(TWILIO_FROM_PARAM);
  if (from === null || from.trim() === "") {
    throw new Error("twilio-sms adapter: inbound is missing a non-empty 'From' sender");
  }

  const e164 = normalizeE164(from);
  if (e164 === DEGENERATE_E164) {
    throw new Error("twilio-sms adapter: 'From' does not normalize to a usable E.164 number");
  }

  return { e164, channelId: SMS_CHANNEL_KIND };
}

/**
 * Construct the SMS adapter for one paired session.
 *
 * Throws at CONSTRUCTION if the D0 table has no `sms` row. That is unreachable
 * today, but `capabilitiesFor` returns `ChannelCapabilities | null` and the only
 * fail-closed reading of `null` is "this channel has no declared capabilities, so
 * it may not be used". Substituting a permissive default here would invent
 * capabilities the audited table never granted — precisely the silent
 * access-widening the `null` exists to prevent. Failing at construction (not at
 * first `deliver`) means a misconfigured channel can never be handed out as a live
 * adapter.
 */
export function createTwilioSmsAdapter(deps: TwilioSmsAdapterDeps): ChannelAdapter {
  const capabilities = capabilitiesFor(SMS_CHANNEL_KIND);
  if (capabilities === null) {
    throw new Error(`twilio-sms adapter: no capability row for channel "${SMS_CHANNEL_KIND}"`);
  }
  // `capabilitiesFor` hands back a FRESH copy of the row. It is stored as-is and
  // never cached across sessions, so two adapters can never share (and mutate)
  // one another's capability object. SMS binds no `companion_text_channel`: that
  // is voice's per-session asymmetry, and inventing one here would fabricate a
  // fallback route the table never declared.

  const send = makeGuardedSink(deps);

  const adapter: ChannelAdapter = {
    capabilities,

    identity(inbound: unknown): ChannelIdentity {
      return identityFromTwilioForm(inbound);
    },

    async deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
      // ALL routing lives in the resolver. `adapter.capabilities` is read live
      // (rather than closing over the local) so a caller that rebinds the property
      // gets the routing it asked for instead of silently stale behavior.
      return deliverViaCapabilities(adapter.capabilities, payload, {
        // Inline = the session's paired peer. For SMS's all-inline row this is the
        // only sink that ever fires.
        inline: (p) => send(deps.session.toE164, p),
        // Companion = the same guarded send, addressed to whatever E.164 the
        // resolver selected. Unreachable for SMS today; correct if the row changes.
        companion: (toE164, p) => send(toE164, p),
      });
    },
  };

  return adapter;
}
