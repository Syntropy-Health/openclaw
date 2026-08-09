/**
 * Kapso WhatsApp channel adapter (Phase 7, task 7.3) — the thin binding between
 * the frozen C0 seam (channel-adapter.ts) and the shipped Kapso/Meta Cloud API
 * rails under `extensions/kapso/`.
 *
 * "Thin" is the whole point. Phase 7 is a pure CONSUMER of the Kapso
 * infrastructure: this file owns no transport, no signature check, no opt-out
 * logic, and — critically — NO ROUTING. It supplies three things and nothing else:
 *
 *   1. `capabilities` — looked up from the D0 table, never hand-written here.
 *   2. `identity()`   — reads a sender out of a raw Kapso/Meta webhook payload.
 *   3. `deliver()`    — hands the payload plus two sinks to the shared resolver.
 *
 * Everything channel-specific about WhatsApp is therefore either declared data
 * (the D0 row) or a sink function. That is the executable form of the A&D §5.1
 * uniformity claim: the same conformance suite runs against voice, sms, and this.
 *
 * This file, twilio-sms-adapter.ts, and twilio-voice-adapter.ts are held
 * DELIBERATELY ISOMORPHIC — same constant names, same error prefix shape, same
 * exhaustiveness arm, same sink/`deliver` structure, same E.164 gate. Three files
 * whose entire thesis is uniformity must not diverge cosmetically; if you change
 * the shape of one, change all three.
 *
 * Provider note: **Kapso is the canonical WhatsApp transport. Baileys is
 * DEPRECATED and is deliberately not imported or referenced anywhere here.**
 */

import type { ResolvedKapsoConfig } from "../../../kapso/src/kapso-config.js";
import { guardedSendKapso } from "../../../kapso/src/kapso-inbound.js";
import type { KapsoFetch } from "../../../kapso/src/kapso-send.js";
import { parseKapsoInbounds } from "../../../kapso/src/kapso-webhook.js";
import type { OptOutStore } from "../../../twilio/src/compliance.js";
import {
  type ChannelAdapter,
  type ChannelIdentity,
  deliverViaCapabilities,
  type DeliveryPayload,
  type DeliveryResult,
} from "../channel-adapter.js";
import { capabilitiesFor } from "../channel-capability-config.js";
import { toCanonicalE164 } from "./e164.js";
import type { AdapterSession } from "./session.js";

/**
 * The D0 lookup key AND the `channelId` this adapter reports. One constant for
 * both on purpose: the capability row and the identity's channel id must never
 * drift apart, because the core resolves capabilities from exactly that id.
 */
const WHATSAPP_CHANNEL_ID = "whatsapp";

/** Uniform prefix for every error this adapter throws (see the file header). */
const ERROR_PREFIX = "whatsapp adapter: ";

export type KapsoWhatsAppAdapterDeps = {
  /** Per-session destination binding. `companionE164` is unused for WhatsApp (see below). */
  session: AdapterSession;
  /** Credential-complete Kapso config (`resolveKapsoConfig` already fail-closed on partials). */
  config: ResolvedKapsoConfig;
  /**
   * Pre-resolved WABA sender phone-number-id. Taken as a plain string rather than
   * resolved in here because `resolveKapsoPhoneNumberId` is ASYNC and the C0
   * factory contract is synchronous — doing the lookup here would either force an
   * async factory (a seam change) or hide an un-awaited promise. The caller that
   * already had to await config resolution passes the resolved value down.
   */
  phoneNumberId: string;
  /** Shared TCPA opt-out store (the same keyspace as SMS — a STOP on either channel suppresses both). */
  store: OptOutStore;
  /** Injected transport; the test seam. Defaults to the global `fetch` inside the send. */
  fetchImpl?: KapsoFetch;
};

/**
 * Render a delivery payload as WhatsApp message text.
 *
 * Deliberately LITERAL — the URL, the code, or the text, and nothing else. R6/R7
 * keep channel payloads identifier-only: no marketing copy, no framing prose, and
 * above all no PHI (the WhatsApp D0 row is `phi_approved: false`; any prose we
 * added here would be content this channel is not cleared to carry).
 *
 * The `default` arm is NOT dead code. The `satisfies never` makes a new
 * {@link DeliveryPayload} kind a COMPILE error, but `deliver()` is reachable from
 * NON-TypeScript callers, and an off-contract kind previously fell out of this
 * switch as `undefined` — which reached the provider as `text: {}` and drew a 400.
 * Throwing here, from INSIDE the sink's `try`, is what turns that into an honest
 * `{ok:false, via:<the real route>}` with no provider traffic. All three adapters
 * now behave identically on an unknown kind.
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
 * Normalize a RAW Kapso/Meta Cloud API webhook payload into a channel identity.
 *
 * The parse is delegated wholesale to the shipped `parseKapsoInbounds`, which
 * already walks `entry[].changes[].value.messages[]`, normalizes Meta's
 * bare-digit `from` to `+E164`, and drops a sender that collapses to the
 * degenerate `"+"`. Re-implementing any of that here would give WhatsApp a
 * second, drifting notion of "who sent this" — the exact duplication Phase 7
 * exists to avoid. It also never mutates its argument, satisfying the seam's
 * no-mutation rule for free.
 *
 * The native `wamid` (the per-message `id`) is READ by the parser and then
 * DISCARDED here: a `ChannelIdentity` carries only `{ e164, channelId }`. The
 * core resolves capabilities by channel KIND, and surfacing a per-conversation
 * id would tempt callers to key sessions on it and re-introduce the
 * channel-specific branching C0 removes.
 *
 * Error messages deliberately omit the offending value — a phone number is an
 * identifier and must not land in logs via a thrown message.
 */
function identityFromWhatsAppWebhook(inbound: unknown): ChannelIdentity {
  const inbounds = parseKapsoInbounds(inbound);

  // ---- THE MOST IMPORTANT DECISION IN THIS FILE: AMBIGUITY FAILS CLOSED ----
  //
  // `identity()` returns a NON-NULLABLE identity, so there is no way to say
  // "I don't know" other than to throw. We therefore demand EXACTLY ONE
  // message and refuse both other cases:
  //
  //  * ZERO messages — a missing/blank/degenerate `from` (the parser drops
  //    all three), or a perfectly valid non-message event such as a
  //    delivery-STATUS callback (`value.statuses[]`, no `value.messages[]`).
  //    There is no sender in the payload at all; fabricating one would bind a
  //    session to a number nobody sent from.
  //
  //  * MORE THAN ONE — Meta coalesces multiple messages into a single webhook
  //    delivery, and those messages can come from DIFFERENT senders. A batch
  //    has no single identity. The tempting shortcut, "take the first one",
  //    is precisely the bug: it would bind an authenticated session to an
  //    ARBITRARY sender chosen by Meta's batching order — an
  //    attacker-influenceable ordering in a security-sensitive auth flow.
  //    Silently authenticating the wrong person is strictly worse than
  //    refusing to authenticate anyone, so we refuse.
  //
  // A caller that legitimately has a batch must fan it out and ask for one
  // identity per message; that is the caller's decision to make explicitly,
  // never ours to guess.
  const only = inbounds.length === 1 ? inbounds[0] : undefined;
  if (!only) {
    throw new Error(
      `${ERROR_PREFIX}cannot derive a single identity — payload yielded ${inbounds.length} identifiable inbound message(s), expected exactly 1`,
    );
  }

  // The parser NORMALIZES but does not VALIDATE: it inherits `normalizeE164`,
  // which scrapes every digit out of any string and only ever produces a bare
  // "+" for wholly non-numeric input. So `from: "0016505551234"` survives the
  // parser as "+0016505551234", and a `from` carrying embedded punctuation
  // survives as a plausible-but-wrong number. `identity()` is an AUTHENTICATION
  // surface, so the canonical-E.164 check is applied POST-PARSE here — the same
  // single gate the other two adapters apply to their raw provider field.
  return {
    e164: toCanonicalE164(only.from, `${ERROR_PREFIX}inbound sender`),
    channelId: WHATSAPP_CHANNEL_ID,
  };
}

/**
 * Build a WhatsApp adapter bound to one paired session.
 *
 * Throws at CONSTRUCTION if the D0 lookup fails, or if the session's destination
 * is not canonical E.164 — see the guards below.
 */
export function createKapsoWhatsAppAdapter(deps: KapsoWhatsAppAdapterDeps): ChannelAdapter {
  // ---------------------------------------------------------------------------
  // Capabilities: sourced from D0, never redeclared.
  // ---------------------------------------------------------------------------
  // `capabilitiesFor` is the single source of truth for what a channel can do. An
  // adapter that wrote its own literal row would let a channel's real capabilities
  // and its declared ones diverge silently — exactly the failure the D0 table
  // exists to prevent. It also returns a FRESH COPY per call, so two adapters on
  // two sessions can never alias one mutable row.
  const capabilities = capabilitiesFor(WHATSAPP_CHANNEL_ID);

  // FAIL CLOSED at construction. `capabilitiesFor` returns `null` for an unknown
  // channel id; `"whatsapp"` is a known row so this is unreachable in practice,
  // but the type admits null and the alternative — substituting a permissive
  // default — would fabricate capabilities the table never granted. An adapter
  // that cannot prove what it is allowed to do must not exist at all, so we refuse
  // to construct rather than hand back an object whose first delivery decision
  // would be a guess.
  if (!capabilities) {
    throw new Error(`${ERROR_PREFIX}no capability row for channel "${WHATSAPP_CHANNEL_ID}"`);
  }

  // NOTE ON `companion_text_channel`: we deliberately do NOT bind
  // `session.companionE164` onto the row. WhatsApp's D0 row is all-inline
  // (`inline_link: true`, `inline_text: true`), so `deliverViaCapabilities` never
  // reaches the companion branch — the companion sink below is unreachable BY
  // CONSTRUCTION. Binding a companion anyway would advertise a fallback route
  // this channel does not have. (Only voice, whose `inline_link` is `false`,
  // binds it.) The sink is still supplied because the resolver's seam takes both,
  // and supplying only one would make this adapter structurally different from
  // the other two for no behavioral gain.

  // THE OUTBOUND HALF OF THE E.164 GATE (TCPA). `guardedSendKapso` hands `to`
  // straight to `store.isOptedOut(to)`, and the durable store matches
  // `channel_peer_id` with an EXACT SQL comparison. Meta delivers `from` as BARE
  // DIGITS, so "16505551234" is exactly the shape a session can be bound with —
  // and it would MISS a STOP row stored as "+16505551234", putting a message on
  // the wire to someone who opted out (the opt-out keyspace is SHARED with SMS,
  // so the STOP may not even have arrived over WhatsApp). Canonicalizing here,
  // once, is what makes the lookup key and the stored key the same string.
  const toE164 = toCanonicalE164(deps.session.toE164, `${ERROR_PREFIX}session destination`);

  /**
   * The one real send. Used by BOTH sinks — they differ only in the destination —
   * which keeps "how WhatsApp sends" in a single place.
   *
   * Contract: resolves `true` iff the message was actually handed to the provider
   * and accepted. It must NEVER throw, because the resolver reports the route it
   * took (`via`) alongside the outcome; a throw would destroy that observable and
   * escape `deliver()` as an exception. `bodyFor` is therefore evaluated INSIDE
   * the `try`: an off-contract payload kind becomes `false` (with zero provider
   * traffic, since it throws before the send) rather than an escaping exception.
   */
  const send = async (to: string, payload: DeliveryPayload): Promise<boolean> => {
    try {
      // `guardedSendKapso`, not the raw `sendKapsoMessage`: the guarded path is the
      // TCPA opt-out enforcement point, and bypassing it here would let an
      // authenticated-access nudge reach someone who sent STOP.
      const result = await guardedSendKapso({
        config: deps.config,
        phoneNumberId: deps.phoneNumberId,
        to,
        body: bodyFor(payload),
        store: deps.store,
        fetchImpl: deps.fetchImpl,
      });
      // Map to the sink's boolean contract. `guardedSendKapso` returns either
      // `{ok:boolean}` or a `SuppressedSend` (`{ok:false, suppressed:true}`), and
      // BOTH collapse to the same answer here: a suppressed send is a real
      // NON-DELIVERY, not a quiet success. Reporting `true` for a suppression
      // would tell the caller a code/link had been sent that the recipient will
      // never see. `=== true` rather than a truthiness check so a
      // contract-violating truthy non-boolean cannot sneak through as delivered.
      // oxlint-disable-next-line no-unnecessary-boolean-literal-compare -- the strict compare is a deliberate runtime guard against a non-boolean `ok` crossing the package boundary; the declared type is not the guarantee here.
      return result.ok === true;
    } catch {
      // FAIL CLOSED on an unexpected transport rejection. `sendKapsoMessage`
      // already converts network errors into `{ok:false}`, and the opt-out read is
      // guarded inside `guardedSendKapso` — but a response-body read or any future
      // change could still reject. Swallowing it into `false` is what preserves
      // the resolver's honest observable: the sink FIRED and failed, so `deliver()`
      // reports `{ok:false, via:"inline"}` — distinct from `via:"none"`, which
      // means nothing was ever attempted. Letting it throw would collapse that
      // distinction into an exception the caller cannot classify.
      return false;
    }
  };

  // Inline: send to the paired peer bound (and canonicalized) at construction.
  const inline = (payload: DeliveryPayload): Promise<boolean> => send(toE164, payload);
  // Companion: send to the number the RESOLVER supplies, never to a destination we
  // picked. Unreachable for WhatsApp's all-inline row (see the note above);
  // present so the seam's shape is uniform across channels.
  const companion = (companionE164: string, payload: DeliveryPayload): Promise<boolean> =>
    send(companionE164, payload);

  const adapter: ChannelAdapter = {
    capabilities,
    identity: identityFromWhatsAppWebhook,

    /**
     * Deliver a payload by DELEGATING the route decision to the shared resolver.
     *
     * There is no `if` here about links, codes, or fallbacks — and there must not
     * be. `deliverViaCapabilities` is the atomicity seam: it reads the D0 row,
     * picks EXACTLY ONE sink (or neither, fail-closed), and reports the route
     * actually taken. An adapter that re-derived that decision would let WhatsApp's
     * behavior drift from the table it declares, and would break the single-place
     * guarantee the whole design rests on.
     *
     * Reading `adapter.capabilities` (rather than the closed-over local) keeps this
     * honest for a caller that rebinds the field on the instance — the resolver
     * always sees the row the adapter is currently advertising.
     */
    deliver(payload: DeliveryPayload): Promise<DeliveryResult> {
      return deliverViaCapabilities(adapter.capabilities, payload, { inline, companion });
    },
  };

  return adapter;
}
