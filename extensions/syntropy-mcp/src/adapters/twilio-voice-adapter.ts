/**
 * TwilioVoiceAdapter (Phase 7.1) — the concrete `voice` binding of the C0
 * {@link ChannelAdapter} seam.
 *
 * Voice is the channel that makes the capability-fallback seam earn its keep. A
 * call can SPEAK a plain message (TTS renders `text` inline) but it cannot render
 * a clickable URL or a readable one-time code — so `link`/`otp` must leave the
 * voice leg entirely and go to the PAIRED companion SMS number. That asymmetry is
 * declared once in the D0 table (`voice` → `inline_link:false, inline_text:true`)
 * and resolved once by {@link deliverViaCapabilities}. This adapter therefore
 * contains ZERO routing logic: it supplies two sinks and a session binding, and
 * lets the shared resolver decide which (if either) fires. Re-implementing the
 * decision here would fork the atomicity seam — the one thing C0 exists to prevent.
 *
 * ## Why `emitTwiml` is INJECTED (this is a seam, NOT a stub)
 *
 * Live voice wiring is explicitly RQ4/devex-gated: Twilio carrier credentials, a
 * provisioned voice line, and the ASR/TTS leg are all still outstanding, so there
 * is no real call to speak into yet. Phase 7 ships the adapter with only the final
 * EMISSION injected. Everything before the emission is real production work done
 * here: the payload is flattened to speakable text, and correct, escaped TwiML is
 * built via the shipped {@link generateNotifyTwiml} builder. When RQ4 lands, the
 * wiring supplies a real `emitTwiml` and nothing in this file changes. Do not
 * mistake the injection for an unimplemented adapter.
 *
 * ## Boundaries
 *
 * This module is a pure CONSUMER of `extensions/twilio` (the TCPA-guarded SMS
 * rail) and `extensions/voice-call` (the TwiML builder). It modifies neither, and
 * it never redeclares its own capability row.
 */

import { normalizeE164 } from "openclaw/plugin-sdk";
import { guardedSendSms, type OptOutStore } from "../../../twilio/src/compliance.js";
import type { ResolvedTwilioSmsConfig } from "../../../twilio/src/config.js";
import type { SmsFetch } from "../../../twilio/src/transport.js";
import { generateNotifyTwiml } from "../../../voice-call/src/manager/twiml.js";
import {
  deliverViaCapabilities,
  type ChannelAdapter,
  type ChannelIdentity,
  type DeliveryPayload,
  type DeliveryResult,
} from "../channel-adapter.js";
import { capabilitiesFor } from "../channel-capability-config.js";
import type { AdapterSession } from "./session.js";

/**
 * The D0 lookup key AND the `channelId` this adapter reports. One constant for
 * both so the capability row and the reported identity can never drift apart.
 */
const VOICE_CHANNEL_ID = "voice";

/** Twilio's default `<Say>` voice; used when the caller injects no preference. */
const DEFAULT_VOICE = "alice";

/**
 * Characters that would break out of the `voice="…"` TwiML attribute.
 *
 * {@link generateNotifyTwiml} escapes the MESSAGE (via `escapeXml`) but
 * interpolates the VOICE name raw into an attribute. That is safe for the
 * operator-supplied names it was designed for, but this adapter accepts `voice`
 * as a dependency, so we validate it at construction rather than trust the
 * caller: an unescaped `"` or `<` in a voice name would let a caller inject
 * arbitrary TwiML verbs into a live call. No legitimate TTS voice name contains
 * any of these, so rejecting them costs nothing and closes the hole.
 */
const XML_UNSAFE = /["'<>&]/;

export type TwilioVoiceAdapterDeps = {
  /**
   * The paired session. `companionE164` is what `link`/`otp` fall back to; with
   * no companion bound those payloads FAIL CLOSED (see {@link createTwilioVoiceAdapter}).
   */
  session: AdapterSession;
  /** Credentials for the companion SMS leg (the fallback route, not the voice leg). */
  smsConfig: ResolvedTwilioSmsConfig;
  /** TCPA opt-out store — consulted by the guarded companion send. */
  store: OptOutStore;
  /**
   * The live TTS leg: receives fully-formed TwiML and emits it into the active
   * call, resolving `true` iff it was accepted. Injected because live voice
   * wiring is RQ4/devex-gated — this adapter still BUILDS the TwiML.
   */
  emitTwiml: (twiml: string) => Promise<boolean>;
  /** `<Say voice="…">` name. Defaults to {@link DEFAULT_VOICE}. */
  voice?: string;
  /** Injected transport for the companion SMS leg (the test seam). */
  fetchImpl?: SmsFetch;
};

/**
 * Flatten a delivery payload to the literal string the channel carries.
 *
 * Deliberately literal — the text, the URL, or the code and nothing else. R6/R7
 * keep channel payloads identifier-only: no marketing copy, no framing prose, and
 * above all no PHI (every D0 row is `phi_approved:false`). Any prose added here
 * would ride out over an unapproved channel.
 *
 * The `switch` is exhaustive over the {@link DeliveryPayload} union; the `never`
 * assignment makes a future payload kind a COMPILE error rather than a silent
 * runtime fall-through that would deliver an empty message.
 */
function payloadToText(payload: DeliveryPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.text;
    case "link":
      return payload.url;
    case "otp":
      return payload.code;
    default: {
      const unreachable: never = payload;
      throw new Error(`twilio-voice: unsupported delivery payload ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Normalize a Twilio VOICE webhook form body into a {@link ChannelIdentity}.
 *
 * Fail-closed by THROWING: {@link ChannelIdentity} is non-nullable, so an inbound
 * we cannot identify must not be smuggled through as a plausible-looking but
 * bogus identity — that would bind a session to the wrong (or to a shared,
 * degenerate) caller. Every rejection below is a case where we do not know who
 * called.
 *
 * The `CallSid` — and every other native per-call field Twilio sends — is
 * DISCARDED. Per the C0 contract the core resolves capabilities by channel KIND
 * and must never see a per-conversation id, so the returned object carries
 * exactly `e164` + `channelId` and nothing else.
 *
 * The inbound is never mutated: only `URLSearchParams#get` is used.
 *
 * Error messages deliberately omit the offending value — the caller ANI is an
 * identifier and must not leak into logs or exception traces.
 */
function identifyVoiceInbound(inbound: unknown): ChannelIdentity {
  // The Twilio voice webhook is an `application/x-www-form-urlencoded` body; the
  // caller is expected to have parsed it into URLSearchParams. Anything else is
  // an unknown shape we must not duck-type our way through.
  if (!(inbound instanceof URLSearchParams)) {
    throw new Error(
      "twilio-voice: identity() expects the Twilio voice webhook form body as URLSearchParams",
    );
  }

  // `From` is the caller ANI. Missing or blank means Twilio gave us no caller
  // (e.g. a withheld/anonymous ANI) — there is no identity to report.
  const from = inbound.get("From");
  if (!from || from.trim() === "") {
    throw new Error("twilio-voice: inbound webhook has no `From` (caller ANI)");
  }

  // `normalizeE164` never throws; it strips non-digits, so a wholly non-numeric
  // sender collapses to the bare "+". That is a DEGENERATE key, not a number —
  // without this guard every malformed caller would share one identity (and thus
  // one session and one opt-out key). Same guard the shipped Kapso parser has.
  const e164 = normalizeE164(from);
  if (e164 === "+") {
    throw new Error("twilio-voice: inbound `From` does not normalize to an E.164 number");
  }

  return { e164, channelId: VOICE_CHANNEL_ID };
}

/**
 * Build the `voice` {@link ChannelAdapter} for one paired session.
 *
 * Routing, in full, is decided by {@link deliverViaCapabilities} from the D0 row
 * — this factory only declares the two sinks:
 *
 *  - `text` → `inline_text:true` → the INLINE sink speaks it via TTS.
 *  - `link` / `otp` → `inline_link:false` → the COMPANION SMS sink, addressed to
 *    `session.companionE164`.
 *  - `link` / `otp` with NO companion bound → FAIL CLOSED: `{ok:false, via:"none"}`,
 *    with NEITHER sink invoked. A voice call that cannot render a link and has no
 *    paired SMS number has nowhere honest to put it; silently speaking a URL
 *    aloud, or dropping it and reporting success, would both be worse than an
 *    explicit failure the caller can react to.
 *
 * @throws if the D0 lookup returns `null`. That is unreachable for the three
 * known kinds, but the type admits it, and a missing capability row must never be
 * papered over with a fabricated permissive default — no row means no idea what
 * this channel may carry, so construction fails.
 * @throws if `voice` contains XML-significant characters (see {@link XML_UNSAFE}).
 */
export function createTwilioVoiceAdapter(deps: TwilioVoiceAdapterDeps): ChannelAdapter {
  // Capabilities come from the D0 table, never a literal. `capabilitiesFor`
  // returns a FRESH copy per call, which is what makes the per-session
  // `companion_text_channel` binding below safe: two adapters built from two
  // sessions never share (and so cannot cross-contaminate) a capability object.
  const capabilities = capabilitiesFor(VOICE_CHANNEL_ID);
  if (!capabilities) {
    // Fail closed at CONSTRUCTION — an adapter with no declared capabilities
    // cannot make a safe routing decision later, so it must not exist at all.
    throw new Error(`twilio-voice: no capability row for channel "${VOICE_CHANNEL_ID}"`);
  }

  // The one per-session binding: the paired SMS number link/otp fall back to.
  // Left `undefined` when the session has no companion — the resolver reads that
  // as "no fallback" and fails closed.
  capabilities.companion_text_channel = deps.session.companionE164;

  const voice = deps.voice ?? DEFAULT_VOICE;
  if (XML_UNSAFE.test(voice)) {
    throw new Error("twilio-voice: `voice` must not contain XML-significant characters");
  }

  /**
   * INLINE sink — speak the payload into the live call.
   *
   * Only a `text` payload can reach here: the D0 row has `inline_link:false`, so
   * the resolver never routes `link`/`otp` inline for voice. The TwiML is built
   * with the shipped {@link generateNotifyTwiml}, which `escapeXml`s the message
   * — so agent text containing `&`, `<`, or a quote is escaped rather than
   * corrupting (or injecting into) the TwiML document.
   *
   * Never throws: a sink's contract is a boolean, and an exception here would
   * escape `deliver()` and crash a caller that is entitled to a `DeliveryResult`.
   * A rejected `emitTwiml` is a non-delivery, which the resolver reports honestly
   * as `{ok:false, via:"inline"}` — the route was really attempted, so it must
   * NOT collapse to `via:"none"` (which means nothing was attempted at all).
   */
  const inline = async (payload: DeliveryPayload): Promise<boolean> => {
    const twiml = generateNotifyTwiml(payloadToText(payload), voice);
    try {
      return Boolean(await deps.emitTwiml(twiml));
    } catch {
      return false;
    }
  };

  /**
   * COMPANION sink — send the payload as an SMS to the paired number.
   *
   * Goes through `guardedSendSms` (the TCPA-guarded path), never raw `sendSms`:
   * the companion number is a real US SMS destination and an opted-out number
   * must receive ZERO messages, including voice fallbacks.
   *
   * The destination is the `toE164` the RESOLVER passes (the trimmed companion),
   * not `session.toE164` — `session.toE164` is the voice leg's peer and is not
   * necessarily the SMS-capable number.
   *
   * Result mapping: only `ok === true` counts as delivered. A suppression
   * (`{ok:false, suppressed:true}`) is a genuine non-delivery, so it maps to
   * `false` — and it must not throw, because a compliant suppression is an
   * expected outcome, not an error. The `try/catch` covers a transport that
   * rejects outright.
   */
  const companion = async (toE164: string, payload: DeliveryPayload): Promise<boolean> => {
    try {
      const result = await guardedSendSms(
        {
          config: deps.smsConfig,
          to: toE164,
          body: payloadToText(payload),
          fetchImpl: deps.fetchImpl,
        },
        deps.store,
      );
      return result.ok === true;
    } catch {
      return false;
    }
  };

  // `deliver` reads `adapter.capabilities` (not the captured local) so that a
  // caller who rebinds the property — as the wiring may when a companion number
  // is paired mid-session — routes against the CURRENT row rather than a stale
  // snapshot captured at construction.
  const adapter: ChannelAdapter = {
    capabilities,
    identity: identifyVoiceInbound,
    deliver: (payload: DeliveryPayload): Promise<DeliveryResult> =>
      deliverViaCapabilities(adapter.capabilities, payload, { inline, companion }),
  };

  return adapter;
}
