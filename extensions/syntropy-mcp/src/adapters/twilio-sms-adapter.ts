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
 *
 * This file, kapso-whatsapp-adapter.ts, and twilio-voice-adapter.ts are held
 * DELIBERATELY ISOMORPHIC — same constant names, same error prefix shape, same
 * exhaustiveness arm, same sink/`deliver` structure, same E.164 gate. Three files
 * whose entire thesis is uniformity must not diverge cosmetically; if you change
 * the shape of one, change all three.
 */

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
import { toCanonicalE164 } from "./e164.js";
import type { AdapterSession } from "./session.js";

/**
 * The D0 lookup key AND the `channelId` reported by `identity()` — deliberately
 * the same constant. `ChannelIdentity.channelId` is the channel KIND, which is
 * precisely the key the core hands back to `capabilitiesFor`; letting the two
 * drift apart would let an identity resolve to a different row than the adapter
 * that produced it.
 */
const SMS_CHANNEL_ID = "sms";

/** Uniform prefix for every error this adapter throws (see the file header). */
const ERROR_PREFIX = "sms adapter: ";

/**
 * The Twilio inbound-webhook form field carrying the sender's number. Twilio posts
 * `application/x-www-form-urlencoded`, so the caller hands us the parsed body as
 * `URLSearchParams` rather than a provider-specific object.
 */
const TWILIO_FROM_PARAM = "From";

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
 *
 * The `default` arm is NOT dead code. The `satisfies never` makes a new
 * {@link DeliveryPayload} kind a COMPILE error, but `deliver()` is reachable from
 * NON-TypeScript callers, and an off-contract kind previously fell out of this
 * switch as `undefined` — which the transport stringified and put on the wire as
 * the literal text "undefined". Throwing here, from INSIDE the sink's `try`, is
 * what turns that into an honest `{ok:false, via:<the real route>}` with no
 * provider traffic. All three adapters now behave identically on an unknown kind.
 *
 * The message carries NO part of the payload: for an off-contract payload the
 * `kind` tag is itself unvalidated caller data, and this adapter's rule is that a
 * thrown message never quotes the offending value (an OTP code or a secure-link
 * URL must never reach a log via an exception).
 */
function bodyFor(payload: DeliveryPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.text;
    case "link":
      return payload.url;
    case "otp":
      return payload.code;
    default:
      payload satisfies never;
      throw new Error(`${ERROR_PREFIX}unsupported delivery payload kind`);
  }
}

/**
 * Read the inbound sender from a Twilio SMS webhook body and canonicalize it.
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
 *  2. missing or blank `From`.
 *  3. a `From` that is not a canonical E.164 number — delegated wholesale to
 *     {@link toCanonicalE164}. That check REPLACES (and subsumes) the old
 *     degenerate-`"+"` guard, which only caught wholly non-numeric input:
 *     `normalizeE164` scrapes every digit out of ANY string, so a Twilio Client
 *     (`client:bob99`) or Programmable-SIP (`sip:alice@1650.555.1234.evil.com`)
 *     sender used to canonicalize to a plausible — and in the SIP case
 *     attacker-chosen, victim-colliding — number. See e164.ts for the measured
 *     collisions.
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
function identityFromSmsWebhook(inbound: unknown): ChannelIdentity {
  if (!(inbound instanceof URLSearchParams)) {
    throw new Error(`${ERROR_PREFIX}inbound must be URLSearchParams (Twilio webhook form body)`);
  }

  const from = inbound.get(TWILIO_FROM_PARAM);
  if (from === null || from.trim() === "") {
    throw new Error(`${ERROR_PREFIX}inbound is missing a non-empty 'From' sender`);
  }

  return {
    e164: toCanonicalE164(from, `${ERROR_PREFIX}inbound 'From'`),
    channelId: SMS_CHANNEL_ID,
  };
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
 *
 * Throws at CONSTRUCTION, for the same fail-closed reason, if the session's
 * destination is not canonical E.164 — see the binding below.
 */
export function createTwilioSmsAdapter(deps: TwilioSmsAdapterDeps): ChannelAdapter {
  const capabilities = capabilitiesFor(SMS_CHANNEL_ID);
  if (!capabilities) {
    throw new Error(`${ERROR_PREFIX}no capability row for channel "${SMS_CHANNEL_ID}"`);
  }
  // `capabilitiesFor` hands back a FRESH copy of the row. It is stored as-is and
  // never cached across sessions, so two adapters can never share (and mutate)
  // one another's capability object. SMS binds no `companion_text_channel`: that
  // is voice's per-session asymmetry, and inventing one here would fabricate a
  // fallback route the table never declared.

  // THE OUTBOUND HALF OF THE E.164 GATE (TCPA). `guardedSendSms` hands `to`
  // straight to `store.isOptedOut(to)`, and the durable store matches
  // `channel_peer_id` with an EXACT SQL comparison. So a session bound as
  // "16505551234" (bare digits — the shape the WhatsApp side receives natively) or
  // "(650) 555-1234" would MISS a STOP row stored as "+16505551234" and put a
  // message on the wire to someone who opted out. Canonicalizing here, once, is
  // what makes the lookup key and the stored key the same string; an
  // uncanonicalizable destination fails the adapter at construction rather than at
  // the first send, matching the capability-row posture above.
  const toE164 = toCanonicalE164(deps.session.toE164, `${ERROR_PREFIX}session destination`);

  /**
   * The one real send. Used by BOTH sinks — they differ only in the destination —
   * which keeps "how SMS sends" in a single place.
   *
   * A sink MUST NOT throw (contract §4.3). The resolver awaits it to decide `ok`,
   * and a throw escaping here would escape `deliver()` entirely — turning a routine
   * provider hiccup into an exception the channel-agnostic core would have to catch,
   * and destroying the `via` information that says which route was actually
   * attempted. So all failure shapes are flattened to `false`:
   *
   *  - a returned failure — `{ok:false}` from the transport, or a `SuppressedSend`
   *    from the opt-out rail. Suppression is a REAL non-delivery: the recipient sent
   *    STOP (or the store was unreadable and the rail failed closed) and no message
   *    went out, so reporting `true` would be a lie that hides a TCPA-relevant event.
   *  - a REJECTED promise. `guardedSendSms` is documented to return rather than
   *    throw, but it is not ours and `store.isOptedOut` may be async — a synchronous
   *    throw before the store read, or any future change downstream, must not be able
   *    to breach the seam. This catch is the belt to that suspenders, not dead code.
   *  - an off-contract payload kind. `bodyFor` is evaluated INSIDE the `try`, on
   *    purpose: that is what converts its throw into `false` (with zero provider
   *    traffic, since it throws before the send) instead of letting it escape
   *    `deliver()`.
   */
  const send = async (to: string, payload: DeliveryPayload): Promise<boolean> => {
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
      // put a message on the wire, so neither is a delivery. `=== true` rather than
      // a truthiness check so a contract-violating truthy non-boolean cannot sneak
      // through as delivered.
      // oxlint-disable-next-line no-unnecessary-boolean-literal-compare -- the strict compare is a deliberate runtime guard against a non-boolean `ok` crossing the package boundary; the declared type is not the guarantee here.
      return result.ok === true;
    } catch {
      // Never let a provider/store fault escape the sink — see the doc above.
      return false;
    }
  };

  // Inline = the session's paired peer (canonicalized above). For SMS's all-inline
  // row this is the only sink that ever fires.
  const inline = (payload: DeliveryPayload): Promise<boolean> => send(toE164, payload);
  // Companion = the same guarded send, addressed to whatever E.164 the RESOLVER
  // selected. Unreachable for SMS today; correct if the row changes.
  const companion = (companionE164: string, payload: DeliveryPayload): Promise<boolean> =>
    send(companionE164, payload);

  const adapter: ChannelAdapter = {
    capabilities,
    identity: identityFromSmsWebhook,

    // ALL routing lives in the resolver. `adapter.capabilities` is read live
    // (rather than closing over the local) so a caller that rebinds the property
    // gets the routing it asked for instead of silently stale behavior.
    deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
      return deliverViaCapabilities(adapter.capabilities, payload, { inline, companion });
    },
  };

  return adapter;
}
