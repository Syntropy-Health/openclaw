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
 *
 * This file, twilio-sms-adapter.ts, and kapso-whatsapp-adapter.ts are held
 * DELIBERATELY ISOMORPHIC — same constant names, same error prefix shape, same
 * exhaustiveness arm, same sink/`deliver` structure, same E.164 gate. Three files
 * whose entire thesis is uniformity must not diverge cosmetically; if you change
 * the shape of one, change all three.
 */

import { guardedSendSms, type OptOutStore } from "../../../twilio/src/compliance.js";
import type { ResolvedTwilioSmsConfig } from "../../../twilio/src/config.js";
import type { SmsFetch } from "../../../twilio/src/transport.js";
import { generateNotifyTwiml } from "../../../voice-call/src/manager/twiml.js";
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
 * The D0 lookup key AND the `channelId` this adapter reports. One constant for
 * both so the capability row and the reported identity can never drift apart.
 */
const VOICE_CHANNEL_ID = "voice";

/** Uniform prefix for every error this adapter throws (see the file header). */
const ERROR_PREFIX = "voice adapter: ";

/** Twilio's default `<Say>` voice; used when the caller injects no preference. */
const DEFAULT_VOICE = "alice";

/**
 * The Twilio inbound-webhook form field carrying the caller's number (the ANI).
 */
const TWILIO_FROM_PARAM = "From";

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
 * The `default` arm is NOT dead code. The `satisfies never` makes a new
 * {@link DeliveryPayload} kind a COMPILE error, but `deliver()` is reachable from
 * NON-TypeScript callers. Throwing here, from INSIDE each sink's `try`, is what
 * turns an off-contract kind into an honest `{ok:false, via:<the real route>}`
 * with no provider traffic. All three adapters now behave identically on an
 * unknown kind — they previously behaved three different ways.
 *
 * The message carries NO part of the payload. It previously interpolated
 * `JSON.stringify(payload)`, which serialized an OTP code or a secure-link URL
 * into an exception message and thus into logs — contradicting this file's own
 * rule that a thrown message never quotes the offending value. The `kind` tag is
 * not interpolated either: for an off-contract payload it is itself unvalidated
 * caller data.
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
function identityFromVoiceWebhook(inbound: unknown): ChannelIdentity {
  // The Twilio voice webhook is an `application/x-www-form-urlencoded` body; the
  // caller is expected to have parsed it into URLSearchParams. Anything else is
  // an unknown shape we must not duck-type our way through.
  if (!(inbound instanceof URLSearchParams)) {
    throw new Error(`${ERROR_PREFIX}inbound must be URLSearchParams (Twilio webhook form body)`);
  }

  // `From` is the caller ANI. Missing or blank means Twilio gave us no caller
  // (e.g. a withheld/anonymous ANI) — there is no identity to report.
  const from = inbound.get(TWILIO_FROM_PARAM);
  if (from === null || from.trim() === "") {
    throw new Error(`${ERROR_PREFIX}inbound is missing a non-empty 'From' sender`);
  }

  // The canonical-E.164 gate REPLACES (and subsumes) the old degenerate-`"+"`
  // check. That check only caught wholly non-numeric input, and voice is the
  // channel where that is least sufficient: a Twilio `From` is NOT always E.164 —
  // Twilio Client sends `client:<identity>` and a Programmable SIP Domain sends a
  // CALLER-SUPPLIED SIP URI. `normalizeE164` scrapes every digit out of either, so
  // `sip:alice@1650.555.1234.evil.com` used to canonicalize to the victim's
  // `+16505551234` on an AUTHENTICATION path. See e164.ts.
  return {
    e164: toCanonicalE164(from, `${ERROR_PREFIX}inbound 'From'`),
    channelId: VOICE_CHANNEL_ID,
  };
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
 * @throws if the session's peer, or a bound companion, is not canonical E.164.
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
    throw new Error(`${ERROR_PREFIX}no capability row for channel "${VOICE_CHANNEL_ID}"`);
  }

  // The voice leg's peer — the number on the call. Not an SMS destination (the
  // inline sink speaks TwiML, it does not address a number), but it is still a
  // session-bound identifier, and the same gate is applied for the same
  // fail-closed reason and for uniformity with the other two adapters: a session
  // whose peer is not a canonical E.164 is a malformed session on an
  // authenticated-access path, whatever the channel.
  toCanonicalE164(deps.session.toE164, `${ERROR_PREFIX}session peer`);

  // THE OUTBOUND HALF OF THE E.164 GATE (TCPA), and the one per-session binding:
  // the paired SMS number `link`/`otp` fall back to. `guardedSendSms` hands the
  // destination straight to `store.isOptedOut(to)` and the durable store matches
  // `channel_peer_id` with an EXACT SQL comparison, so a companion bound as
  // "16505551234" or "(650) 555-1234" would MISS a STOP row stored as
  // "+16505551234" and put an OTP on the wire to someone who opted out.
  // Canonicalizing BEFORE the value is bound onto the row is what makes the
  // number the resolver hands the sink already opt-out-comparable.
  //
  // A blank/whitespace-only companion is treated as ABSENT rather than as an
  // error: `deliverViaCapabilities` documents exactly that reading (it trims and
  // falls through to fail-closed), so "unset" stays expressible and a voice
  // session with no companion keeps failing closed on link/otp instead of failing
  // to construct. A NON-blank companion that will not canonicalize is a real
  // misconfiguration and throws.
  const companionE164 = deps.session.companionE164?.trim();
  capabilities.companion_text_channel =
    companionE164 === undefined || companionE164 === ""
      ? undefined
      : toCanonicalE164(companionE164, `${ERROR_PREFIX}session companion`);

  const voice = deps.voice ?? DEFAULT_VOICE;
  if (XML_UNSAFE.test(voice)) {
    throw new Error(`${ERROR_PREFIX}\`voice\` must not contain XML-significant characters`);
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
   *
   * The TwiML is BUILT INSIDE the `try`, which is load-bearing and was the bug:
   * built outside, a throw from the build escaped `deliver()` and destroyed that
   * `via` observable. Two real throw sources exist — `bodyFor`'s off-contract
   * `default` arm, and `escapeXml`, which calls `.replace` on its argument and so
   * raises a `TypeError` for a non-TS caller's `{kind:"text", text:undefined}`.
   * Both must land in this `catch`. The sibling adapters build their body inside
   * the `try` for the same reason.
   */
  const inline = async (payload: DeliveryPayload): Promise<boolean> => {
    try {
      const twiml = generateNotifyTwiml(bodyFor(payload), voice);
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
   * The destination is the `toE164` the RESOLVER passes (the trimmed, canonical
   * companion bound above), not `session.toE164` — `session.toE164` is the voice
   * leg's peer and is not necessarily the SMS-capable number.
   *
   * Result mapping: only `ok === true` counts as delivered. A suppression
   * (`{ok:false, suppressed:true}`) is a genuine non-delivery, so it maps to
   * `false` — and it must not throw, because a compliant suppression is an
   * expected outcome, not an error. The `try/catch` covers a transport that
   * rejects outright, and `bodyFor` is evaluated inside it so an off-contract
   * payload kind becomes `false` with zero provider traffic.
   */
  const companion = async (toE164: string, payload: DeliveryPayload): Promise<boolean> => {
    try {
      const result = await guardedSendSms(
        {
          config: deps.smsConfig,
          to: toE164,
          body: bodyFor(payload),
          fetchImpl: deps.fetchImpl,
        },
        deps.store,
      );
      // `=== true` rather than a truthiness check so a contract-violating truthy
      // non-boolean cannot sneak through as delivered.
      // oxlint-disable-next-line no-unnecessary-boolean-literal-compare -- the strict compare is a deliberate runtime guard against a non-boolean `ok` crossing the package boundary; the declared type is not the guarantee here.
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
    identity: identityFromVoiceWebhook,

    deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
      return deliverViaCapabilities(adapter.capabilities, payload, { inline, companion });
    },
  };

  return adapter;
}
