import { describe, expect, it, vi } from "vitest";
import type { ResolvedKapsoConfig } from "../../../kapso/src/kapso-config.js";
import type { OptOutStore } from "../../../twilio/src/compliance.js";
import type { ResolvedTwilioSmsConfig } from "../../../twilio/src/config.js";
import { generateNotifyTwiml } from "../../../voice-call/src/manager/twiml.js";
import type { ChannelAdapter, ChannelCapabilities, DeliveryPayload } from "../channel-adapter.js";
import { capabilitiesFor, knownChannelIds } from "../channel-capability-config.js";
import { createKapsoWhatsAppAdapter } from "./kapso-whatsapp-adapter.js";
import { createTwilioSmsAdapter } from "./twilio-sms-adapter.js";
import { createTwilioVoiceAdapter } from "./twilio-voice-adapter.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 7 (thin channel adapters), amended by #216:
// the voice and sms cases are RETIRED with their D0 rows; whatsapp remains.
// Authored from PHASE7-CONTRACT.md + the FROZEN C0 seam ONLY; no adapter
// implementation was read.
//
// Core invariant under challenge: UNIFORMITY (A&D §5.1) — N providers, ONE
// shared body (post-#216, N=1; the uniformity proof regains force when a
// channel returns). A channel is allowed to differ in exactly two places — (a) how it
// names an inbound sender and (b) how it physically delivers — and BOTH are
// absorbed as declared capability data by C0. Everything else must be identical,
// so this file is parameterized over a descriptor table and every assertion below
// runs N times against a single body. Three hand-written copies would prove
// nothing; one body that all three satisfy IS the proof.
//
// THREE observables are asserted together everywhere routing is involved:
//   1. the returned `via`               — the adapter's own claim about the route;
//   2. WHICH SINK physically fired      — a `sinkId` pushed by the FAKE ITSELF
//      ("twilio-rest" | "kapso-rest" | "twiml-emit"), never inferred from the
//      destination. Inferring the route from the destination makes a TTS emission
//      and an SMS to the same peer indistinguishable — i.e. it cannot see a
//      deleted TTS leg, which is the entire 7.1 deliverable;
//   3. the DESTINATION and the ARTIFACT — the exact wire values, by equality.
// `via` alone can be faked; a sink call alone hides the honest route; a
// `toContain` artifact check passes anything ADDED. In particular `via:"none"`
// means NOTHING WAS ATTEMPTED (Phase 0 finding F5) — a sink that fired and
// reported failure must KEEP its real route.
//
// Fixture discipline: `session.toE164`, the companion number and `config.smsNumber`
// are THREE MUTUALLY DISTINCT E.164s, so a wrong-destination bug (e.g. the store
// texting itself) cannot alias into a passing assertion.
//
// House style per contract §7: NO `vi.mock` anywhere. Pure DI — injected
// `fetchImpl` transports, an in-memory OptOutStore literal, a `vi.fn` emitTwiml,
// plain typed config fixtures, zero env mutation.
//
// OPEN QUESTIONS FOR THE PRINCIPAL (contract silent — behaviour NOT invented here):
//  Q1. [NO LONGER EXERCISED post-#216 — the assertion arm retired with the
//      voice case; the question STANDS OPEN for any voice restoration.]
//      Is the voice INLINE (TTS) leg TCPA-gated? Contract §5.3 wires it to the
//      injected `emitTwiml` with no `OptOutStore` in the path, while §5.1/§5.2
//      route the SMS/WhatsApp legs through `guardedSendSms`/`guardedSendKapso`.
//      This suite therefore treats TCPA suppression as a property of the SINK
//      (see GUARDED_SINKS) rather than of the adapter: every store-backed sink
//      must suppress; the live-call TTS leg is asserted as NOT store-gated. If
//      the intent is that an opted-out peer must also not be spoken to, say so
//      in the contract and flip GUARDED_SINKS — do not silently change the impl.
//  Q2. (RESOLVED) `knownChannelIds()` now exposes the D0 row set, so the table's
//      CARDINALITY is locked and the post-BAA `phi_approved` invariant is driven
//      by iterating the real rows — a future 4th channel is forced through it.
// ---------------------------------------------------------------------------

// --- shared fixtures --------------------------------------------------------

/** The paired peer: both the inbound SENDER in every fixture and `session.toE164`. */
const PEER_E164 = "+16505551234";
/** Meta's Cloud API delivers `from` as BARE digits — normalization is under test. */
const PEER_BARE_DIGITS = "16505551234";
/** The voice companion SMS leg. DISTINCT from both the peer and the store's number. */
const COMPANION_E164 = "+15551230001";
const OTHER_COMPANION_E164 = "+15551239999";
/** The STORE's own number (the `From`). DISTINCT from the peer, so "text yourself" fails. */
const STORE_SMS_NUMBER = "+15550001234";
const KAPSO_PHONE_NUMBER_ID = "PN_conformance";

const TWILIO_CONFIG: ResolvedTwilioSmsConfig = {
  accountSid: "AC_conformance",
  apiKeySid: "SK_conformance",
  apiKeySecret: "secret_value_never_leak",
  authToken: "authtok_webhook_only",
  smsNumber: STORE_SMS_NUMBER,
  inbound: "pairing",
  allowFrom: [],
};

const KAPSO_CONFIG: ResolvedKapsoConfig = {
  apiKey: "kapso_api_key",
  baseUrl: "https://api.kapso.ai/meta/whatsapp/v24.0",
  phoneNumberId: KAPSO_PHONE_NUMBER_ID,
  appSecret: "meta_app_secret",
  inbound: "pairing",
  allowFrom: [],
};

/**
 * In-memory opt-out store. `optedOut` is threaded from the descriptor so the TCPA
 * rail is actually exercised (an always-empty store makes `guardedSendX` and the
 * raw `sendX` indistinguishable — the rail is then untested by construction).
 * `throws` drives the FAIL-CLOSED arm: an unavailable store must suppress, never
 * let a send through.
 */
function makeStore(optedOut: Set<string> = new Set(), throws = false): OptOutStore {
  return {
    isOptedOut: (e164: string) => {
      if (throws) {
        throw new Error("opt-out store unavailable");
      }
      return optedOut.has(e164);
    },
    optOut: (e164: string) => {
      optedOut.add(e164);
    },
    optIn: (e164: string) => {
      optedOut.delete(e164);
    },
  };
}

const TEXT_LITERAL = "your session is ready";
const LINK_LITERAL = "https://sj.local/verify?t=abc";
const OTP_LITERAL = "482913";
/** The contract's default TTS voice (§5.3: `voice?: string` defaults to "alice"). */

type PayloadKind = DeliveryPayload["kind"];

const PAYLOADS: Array<[PayloadKind, DeliveryPayload]> = [
  ["text", { kind: "text", text: TEXT_LITERAL }],
  ["link", { kind: "link", url: LINK_LITERAL }],
  ["otp", { kind: "otp", code: OTP_LITERAL }],
];

/** The literal a payload must carry to the wire (contract §5.1 — no extra prose). */
function literalOf(payload: DeliveryPayload): string {
  switch (payload.kind) {
    case "text":
      return payload.text;
    case "link":
      return payload.url;
    case "otp":
      return payload.code;
  }
}

/** Senders that MUST fail closed by THROWING out of `identity()` (contract §4.2). */
const BAD_SENDERS: Array<[string, string | null]> = [
  ["a missing sender", null],
  ["an empty sender", ""],
  ["a whitespace-only sender", "   "],
  ['a non-digit sender that collapses to the degenerate "+"', "not-a-number"],
];

function d0Row(kind: string): ChannelCapabilities {
  const row = capabilitiesFor(kind);
  if (!row) {
    throw new Error(`no D0 row for kind "${kind}" — fixture is wrong`);
  }
  return row;
}

// --- provider fakes ---------------------------------------------------------

/**
 * How the injected provider behaves for one adapter construction.
 *  - "ok"        — a well-formed success response.
 *  - "fail"      — a well-formed provider ERROR response (the transport converts
 *                  it to `{ok:false}`; the sink never sees an exception).
 *  - "reject"    — the transport itself rejects. NOTE: `sendTwilioMessage` /
 *                  `sendKapsoMessage` already catch a rejecting fetch, so this
 *                  mode does NOT reach an adapter's own catch for sms/whatsapp.
 *  - "malformed" — the transport RESOLVES a non-Response object, so the provider
 *                  LIBRARY throws (`response.text is not a function`) INSIDE the
 *                  sink. This is the only mode that genuinely exercises "a sink
 *                  must not throw" on the REST-backed channels.
 */
type ProviderMode = "ok" | "fail" | "reject" | "malformed";

/** Which physical sink fired. Pushed BY THE FAKE — never inferred from a destination. */
type SinkId = "twilio-rest" | "kapso-rest" | "twiml-emit";

/**
 * Sinks that sit behind the TCPA opt-out rail (`guardedSendSms` /
 * `guardedSendKapso`). The live-call TTS leg is not one of them — see Q1.
 */
const GUARDED_SINKS = new Set<SinkId>(["twilio-rest", "kapso-rest"]);

type Route = "inline" | "companion";

/**
 * One physical provider call. `to` is the WIRE destination (null for the TTS leg,
 * which is emitted into the already-established call and carries no address).
 */
type Hit = { sinkId: SinkId; to: string | null; artifact: string };

/** Twilio REST transport (the SMS inline leg AND the voice companion leg). */
function makeSmsTransport(hits: Hit[], mode: ProviderMode) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const form = init.body as URLSearchParams;
    hits.push({ sinkId: "twilio-rest", to: form.get("To"), artifact: form.get("Body") ?? "" });
    if (mode === "reject") {
      throw new Error("twilio transport rejected");
    }
    // A NON-Response resolution: the provider library throws while reading it.
    if (mode === "malformed") {
      return {} as unknown as Response;
    }
    return mode === "fail"
      ? new Response(JSON.stringify({ code: 21211, message: "rejected by carrier" }), {
          status: 400,
        })
      : new Response(JSON.stringify({ sid: "SM_ok", status: "queued" }), { status: 201 });
  }) as unknown as typeof fetch;
}

/** Kapso / Cloud API transport (the WhatsApp inline leg). */
function makeKapsoTransport(hits: Hit[], mode: ProviderMode) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    // The Cloud API send serializes its payload with JSON.stringify, so the body is
    // a string. Narrowing (rather than coercing) makes a non-string body a visible
    // fixture failure instead of a silent "[object Object]" parse error.
    const raw = typeof init.body === "string" ? init.body : "";
    const payload = JSON.parse(raw) as { to?: string; text?: { body?: string } };
    hits.push({ sinkId: "kapso-rest", to: payload.to ?? null, artifact: payload.text?.body ?? "" });
    if (mode === "reject") {
      throw new Error("kapso transport rejected");
    }
    if (mode === "malformed") {
      return {} as unknown as Response;
    }
    return mode === "fail"
      ? new Response(JSON.stringify({ error: { message: "rejected by cloud api" } }), {
          status: 400,
        })
      : new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

/**
 * The voice inline (TTS) leg — records the TwiML it was handed under its OWN
 * sink id, which is what makes a deleted/substituted TTS leg observable.
 * `emitTwiml` is the injected provider itself, so "malformed" and "reject" are
 * the same thing here: the provider throws inside the sink.
 */
function makeEmitTwiml(hits: Hit[], mode: ProviderMode) {
  return vi.fn(async (twiml: string): Promise<boolean> => {
    hits.push({ sinkId: "twiml-emit", to: null, artifact: twiml });
    if (mode === "reject" || mode === "malformed") {
      throw new Error("tts leg threw");
    }
    return mode !== "fail";
  });
}

// --- native inbound fixtures (REAL provider shapes) -------------------------
//
// Every inbound is built by a FACTORY, fresh per test. A shared module-level
// instance would turn "identity() mutated its argument" into order-dependent
// flakiness somewhere else instead of a clean failure at the mutation test.

/** Twilio webhook form body (voice AND sms): `From` is already E.164. */

const WHATSAPP_WAMID = "wamid.NATIVE0001";

/** One Cloud API `entry[]` element carrying the given messages. */
function whatsappEntry(messages: Array<Record<string, unknown>>, entryId = "WABA"): unknown {
  return {
    id: entryId,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { phone_number_id: KAPSO_PHONE_NUMBER_ID },
          messages,
        },
      },
    ],
  };
}

/** Raw Meta/Kapso webhook payload. `from` arrives as BARE digits (no leading "+"). */
function whatsappInbound(sender: string | null): unknown {
  const message: Record<string, unknown> = {
    id: WHATSAPP_WAMID,
    type: "text",
    text: { body: "hi" },
  };
  if (sender !== null) {
    message.from = sender;
  }
  return { object: "whatsapp_business_account", entry: [whatsappEntry([message])] };
}

/** A delivery-status-only event: ZERO messages → no single identity → must throw. */
function whatsappZeroMessageInbound(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: KAPSO_PHONE_NUMBER_ID },
              statuses: [
                { id: WHATSAPP_WAMID, status: "delivered", recipient_id: PEER_BARE_DIGITS },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Meta coalesces messages: TWO senders in one delivery → ambiguous → must throw. */
function whatsappTwoSenderInbound(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      whatsappEntry([
        { from: PEER_BARE_DIGITS, id: WHATSAPP_WAMID, type: "text", text: { body: "hi" } },
        { from: "16505559999", id: "wamid.NATIVE0002", type: "text", text: { body: "yo" } },
      ]),
    ],
  };
}

/**
 * TWO messages from the SAME sender. Still ambiguous per §5.2 ("exactly one
 * inbound message" is the only accepted case) — and an implementation that
 * de-duplicated by sender, or took `[0]` after a uniqueness check, would sail
 * through the two-SENDER fixture above.
 */
function whatsappTwoMessagesSameSenderInbound(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      whatsappEntry([
        { from: PEER_BARE_DIGITS, id: WHATSAPP_WAMID, type: "text", text: { body: "hi" } },
        { from: PEER_BARE_DIGITS, id: "wamid.NATIVE0003", type: "text", text: { body: "again" } },
      ]),
    ],
  };
}

/**
 * The batch SPLIT ACROSS TWO `entry[]` elements — the shape that catches a parser
 * reading only `entry[0]`. Two messages total ⇒ still ambiguous ⇒ must throw.
 */
function whatsappSplitEntryInbound(): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      whatsappEntry(
        [{ from: PEER_BARE_DIGITS, id: WHATSAPP_WAMID, type: "text", text: { body: "hi" } }],
        "WABA_A",
      ),
      whatsappEntry(
        [{ from: "16505558888", id: "wamid.NATIVE0004", type: "text", text: { body: "yo" } }],
        "WABA_B",
      ),
    ],
  };
}

/**
 * A stable, comparable view of an inbound so mutation is detectable. Key order is
 * normalized (`URLSearchParams` preserves insertion order) so a REORDERING is not
 * mistaken for a mutation — only an added/removed/changed pair is.
 */
function serializeInbound(inbound: unknown): unknown {
  return inbound instanceof URLSearchParams
    ? [...inbound.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))
    : inbound;
}

// --- the descriptor table ---------------------------------------------------
//
// Each adapter contributes DATA only: how to build it against fakes, the D0 route
// it must take per payload kind, WHICH SINK each route must physically use, the
// EXACT artifact each route must put on the wire, and its native inbound shapes.
// All behaviour is asserted by the single shared body below.

type Harness = {
  adapter: ChannelAdapter;
  /** Provider hits in call order — the ground truth for "which sink fired". */
  hits: Hit[];
};

type MakeOpts = {
  companion?: string;
  mode?: ProviderMode;
  /** Destinations pre-seeded as opted out — the TCPA rail's real input. */
  optedOut?: Set<string>;
  /** Make the opt-out store throw (the fail-closed arm). */
  storeThrows?: boolean;
};

type AdapterCase = {
  /** The D0 lookup key AND the required `identity().channelId`. */
  kind: string;
  /** Construct the adapter bound to fresh fakes. */
  make: (opts: MakeOpts) => Harness;
  /** What `capabilities.companion_text_channel` must be for a given session companion. */
  expectedCompanion: (sessionCompanion: string | undefined) => string | undefined;
  /** Route each payload kind must take WITH a companion bound. */
  routeWithCompanion: Record<PayloadKind, Route>;
  /** Route each payload kind must take with NO companion bound ("none" = fail closed). */
  routeWithoutCompanion: Record<PayloadKind, Route | "none">;
  /** The PHYSICAL sink the inline route must use. */
  expectedInlineSink: SinkId;
  /** The PHYSICAL sink the companion route must use. */
  expectedCompanionSink: SinkId;
  /** The inline route's wire destination (null = the sink carries no address). */
  expectedInlineTo: string | null;
  /** The EXACT artifact a route must put on the wire — equality, never `toContain`. */
  expectedArtifact: (payload: DeliveryPayload, route: Route) => string;
  /**
   * Mutate a live capability row so that a `link` can no longer go inline, forcing
   * the companion decision. Voice is already `inline_link:false`, so it is a no-op
   * there; sms/whatsapp need the flip. This keeps the live-capabilities test in the
   * SHARED body instead of making it a voice special case.
   */
  denyInlineLink: (caps: ChannelCapabilities) => void;
  /** A FRESH native inbound whose sender is the peer. */
  nativeInbound: () => unknown;
  /** The native per-conversation id that fixture carries — MUST be discarded. */
  nativeId: string;
  /** Same native shape with an arbitrary/absent sender (null = the field is omitted). */
  inboundWithSender: (sender: string | null) => unknown;
  /** Further provider-specific inbounds that must fail closed by throwing. */
  extraBadInbounds: Array<[string, () => unknown]>;
};

// SYN-272 R2: sms fixtures restored verbatim from 48ec6c6a1^ with the case.
const SMS_MESSAGE_SID = "SM00000000000000000000000000000001";

function twilioForm(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

function smsInbound(sender: string | null): URLSearchParams {
  const fields: Record<string, string> = {
    To: STORE_SMS_NUMBER,
    MessageSid: SMS_MESSAGE_SID,
    Body: "hi",
    NumMedia: "0",
  };
  if (sender !== null) {
    fields.From = sender;
  }
  return twilioForm(fields);
}

/** One Cloud API `entry[]` element carrying the given messages. */

const CASES: AdapterCase[] = [
  // #216 (2026-08-21) retired the `voice` and `sms` cases with their D0 rows.
  // SYN-272 R2 (2026-09-02, [PRINCIPAL-RULED 2026-08-27] supersession —
  // channel-surfaces PVR) RESTORES the sms case, verbatim from git history
  // at 48ec6c6a1^ exactly as the retirement comment instructed — the QG4 F5
  // binding (row set == case set) is what forced this restoration to ride
  // the row, which is that gate doing its job. `voice` stays retired
  // [CTO-JUDGEMENT #6654 — untouched by the supersession]; when voice
  // returns, restore its case from git history at 48ec6c6a1^.
  {
    kind: "sms",
    make: ({ companion, mode = "ok", optedOut, storeThrows }) => {
      const hits: Hit[] = [];
      const adapter = createTwilioSmsAdapter({
        session: { toE164: PEER_E164, companionE164: companion },
        config: TWILIO_CONFIG,
        store: makeStore(optedOut, storeThrows),
        fetchImpl: makeSmsTransport(hits, mode),
      });
      return { adapter, hits };
    },
    expectedCompanion: () => undefined,
    routeWithCompanion: { text: "inline", link: "inline", otp: "inline" },
    routeWithoutCompanion: { text: "inline", link: "inline", otp: "inline" },
    expectedInlineSink: "twilio-rest",
    expectedCompanionSink: "twilio-rest",
    expectedInlineTo: PEER_E164,
    expectedArtifact: (payload) => literalOf(payload),
    denyInlineLink: (caps) => {
      caps.inline_link = false;
    },
    nativeInbound: () => smsInbound(PEER_E164),
    nativeId: SMS_MESSAGE_SID,
    inboundWithSender: smsInbound,
    extraBadInbounds: [["an inbound that is not URLSearchParams", () => ({ From: PEER_E164 })]],
  },
  {
    kind: "whatsapp",
    make: ({ companion, mode = "ok", optedOut, storeThrows }) => {
      const hits: Hit[] = [];
      const adapter = createKapsoWhatsAppAdapter({
        session: { toE164: PEER_E164, companionE164: companion },
        config: KAPSO_CONFIG,
        phoneNumberId: KAPSO_PHONE_NUMBER_ID,
        store: makeStore(optedOut, storeThrows),
        fetchImpl: makeKapsoTransport(hits, mode),
      });
      return { adapter, hits };
    },
    expectedCompanion: () => undefined,
    routeWithCompanion: { text: "inline", link: "inline", otp: "inline" },
    routeWithoutCompanion: { text: "inline", link: "inline", otp: "inline" },
    expectedInlineSink: "kapso-rest",
    expectedCompanionSink: "kapso-rest",
    expectedInlineTo: PEER_E164,
    expectedArtifact: (payload) => literalOf(payload),
    denyInlineLink: (caps) => {
      caps.inline_link = false;
    },
    nativeInbound: () => whatsappInbound(PEER_BARE_DIGITS),
    nativeId: WHATSAPP_WAMID,
    inboundWithSender: whatsappInbound,
    extraBadInbounds: [
      ["a delivery-status-only event with ZERO messages", whatsappZeroMessageInbound],
      ["a coalesced delivery with TWO senders (ambiguous)", whatsappTwoSenderInbound],
      [
        "a coalesced delivery with TWO messages from the SAME sender (still ambiguous)",
        whatsappTwoMessagesSameSenderInbound,
      ],
      ["a batch split across TWO entry[] elements", whatsappSplitEntryInbound],
    ],
  },
];

/**
 * The capability row an adapter MUST expose, built from the LIVE D0 row so the
 * expectation cannot drift from the table.
 *
 * Key SHAPE is part of the expectation, which is why this is compared with
 * `toStrictEqual`: the D0 `voice` row carries an explicit `companion_text_channel`
 * key (value `undefined`) while `sms`/`whatsapp` OMIT it entirely. That shape is
 * only reproduced by actually spreading `capabilitiesFor(kind)`; a hand-written
 * literal has to guess it. The expected object is therefore built CONDITIONALLY
 * per descriptor (spread the real row, then bind the companion only when the
 * descriptor says this channel has one) rather than hard-coding a literal that
 * would carry `companion_text_channel: undefined` on every channel.
 */
function expectedCaps(c: AdapterCase, sessionCompanion: string | undefined): ChannelCapabilities {
  const expected = { ...d0Row(c.kind) };
  const companion = c.expectedCompanion(sessionCompanion);
  if (companion !== undefined) {
    expected.companion_text_channel = companion;
  }
  return expected;
}

/** The physical sink a given route must use, per the descriptor. */
function sinkFor(c: AdapterCase, route: Route): SinkId {
  return route === "inline" ? c.expectedInlineSink : c.expectedCompanionSink;
}

/** The wire destination a given route must address, per the descriptor. */
function toFor(c: AdapterCase, route: Route): string | null {
  return route === "inline" ? c.expectedInlineTo : COMPANION_E164;
}

/** Assert `hits` is EXACTLY one call, on the right sink, to the right number, with the right bytes. */
function expectSingleHit(
  c: AdapterCase,
  hits: Hit[],
  route: Route,
  payload: DeliveryPayload,
): void {
  expect(hits).toHaveLength(1);
  expect(hits[0].sinkId).toBe(sinkFor(c, route));
  expect(hits[0].to).toBe(toFor(c, route));
  expect(hits[0].artifact).toBe(c.expectedArtifact(payload, route));
  // The inline sink fired exactly once iff this was the inline route (and, for
  // voice, this is literally "emitTwiml was called once / never").
  expect(hits.filter((h) => h.sinkId === c.expectedInlineSink)).toHaveLength(
    sinkFor(c, route) === c.expectedInlineSink ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// THE SHARED BODY — one suite, executed once per descriptor. Nothing below
// branches on a channel name; every per-channel fact comes from the table above.
// ---------------------------------------------------------------------------

describe.each(CASES.map((c) => [c.kind, c] as const))(
  "ChannelAdapter conformance — %s",
  (_kind, c) => {
    // §6.1 — capability rows come from D0, never from a hand-written literal.
    it("sources `capabilities` from the D0 table (capabilitiesFor), no redeclared row", () => {
      const { adapter } = c.make({ companion: COMPANION_E164 });
      expect(adapter.capabilities).toStrictEqual(expectedCaps(c, COMPANION_E164));
    });

    it("matches the D0 row exactly — key shape included — when no companion is bound", () => {
      const { adapter } = c.make({});
      expect(adapter.capabilities).toStrictEqual(expectedCaps(c, undefined));
      // Same key SET as the table row: no invented fields, none dropped.
      expect(Object.keys(adapter.capabilities).toSorted()).toEqual(
        Object.keys(d0Row(c.kind)).toSorted(),
      );
    });

    // §6.2 — the post-BAA invariant: no channel carries PHI today.
    it("declares phi_approved === false (post-BAA invariant)", () => {
      expect(c.make({ companion: COMPANION_E164 }).adapter.capabilities.phi_approved).toBe(false);
      expect(c.make({}).adapter.capabilities.phi_approved).toBe(false);
    });

    // §6.3 — normalization to E.164 + the channel KIND as channelId.
    it("normalizes the native inbound sender to E.164 and reports the channel KIND", () => {
      const identity = c.make({}).adapter.identity(c.nativeInbound());
      expect(identity.e164).toBe(PEER_E164);
      expect(identity.channelId).toBe(c.kind);
    });

    // §6.4 — the native per-conversation id (CallSid / MessageSid / wamid) is DROPPED.
    it("discards the native per-conversation id — identity is exactly { e164, channelId }", () => {
      const identity = c.make({}).adapter.identity(c.nativeInbound());
      expect(Object.keys(identity).toSorted()).toEqual(["channelId", "e164"]);
      expect(Object.values(identity)).not.toContain(c.nativeId);
      expect(JSON.stringify(identity)).not.toContain(c.nativeId);
    });

    // §4.2 — "Never mutate the inbound argument." A fresh fixture per test, so a
    // mutation fails HERE instead of leaking as flakiness into another test.
    it("does not mutate the inbound argument, and is idempotent across calls", () => {
      const { adapter } = c.make({});
      const inbound = c.nativeInbound();
      const before = structuredClone(serializeInbound(inbound));

      const first = adapter.identity(inbound);
      expect(serializeInbound(inbound)).toEqual(before);

      const second = adapter.identity(inbound);
      expect(second).toEqual(first);
      expect(serializeInbound(inbound)).toEqual(before);
    });

    // §6.5 — an unidentifiable inbound must THROW (the return type is non-nullable,
    // so a bogus identity is the only alternative — and that is unacceptable).
    it.each(BAD_SENDERS)("throws (fails closed) on %s", (_label, sender) => {
      const { adapter } = c.make({});
      expect(() => adapter.identity(c.inboundWithSender(sender))).toThrow();
    });

    it.each(c.extraBadInbounds)("throws (fails closed) on %s", (_label, build) => {
      const { adapter } = c.make({});
      expect(() => adapter.identity(build())).toThrow();
    });

    // §6.6 — routing is the D0 row resolved by the SHARED resolver. Asserted through
    // the returned `via`, the SINK that physically fired, the DESTINATION it
    // addressed, and the EXACT artifact it carried.
    it.each(PAYLOADS)(
      "routes a %s payload per its D0 row (companion bound) — via + sink + destination + artifact agree",
      async (kind, payload) => {
        const { adapter, hits } = c.make({ companion: COMPANION_E164 });
        const expected = c.routeWithCompanion[kind];

        await expect(adapter.deliver(payload)).resolves.toEqual({ ok: true, via: expected });
        expectSingleHit(c, hits, expected, payload);
      },
    );

    it.each(PAYLOADS)(
      "routes a %s payload per its D0 row with NO companion — fails closed when unroutable",
      async (kind, payload) => {
        const { adapter, hits } = c.make({});
        const expected = c.routeWithoutCompanion[kind];

        const result = await adapter.deliver(payload);
        expect(result.via).toBe(expected);

        if (expected === "none") {
          // via:"none" is the honest observable for "nothing was attempted".
          expect(result.ok).toBe(false);
          expect(hits).toEqual([]);
        } else {
          expect(result.ok).toBe(true);
          expectSingleHit(c, hits, expected, payload);
        }
      },
    );

    // §6.7 — a sink that FIRED and reported failure keeps its real route. Collapsing
    // to "none" would claim nothing was attempted (Phase 0 finding F5).
    it.each(PAYLOADS)(
      "keeps the real route when the %s delivery's provider reports failure",
      async (kind, payload) => {
        const { adapter, hits } = c.make({ companion: COMPANION_E164, mode: "fail" });
        const expected = c.routeWithCompanion[kind];

        const result = await adapter.deliver(payload);
        expect(result).toEqual({ ok: false, via: expected });
        expect(result.via).not.toBe("none");
        expectSingleHit(c, hits, expected, payload);
      },
    );

    // §6.8 (transport-level) — a rejecting transport surfaces as ok:false.
    it.each(PAYLOADS)(
      "surfaces a rejecting provider as ok:false, never as a thrown %s delivery",
      async (kind, payload) => {
        const { adapter, hits } = c.make({ companion: COMPANION_E164, mode: "reject" });
        const expected = c.routeWithCompanion[kind];

        await expect(adapter.deliver(payload)).resolves.toEqual({ ok: false, via: expected });
        expectSingleHit(c, hits, expected, payload);
      },
    );

    // §4.3 / §6.8 (sink-level) — THE sink-must-not-throw test with teeth. "reject"
    // above never reaches an adapter's own catch on the REST channels, because
    // sendTwilioMessage / sendKapsoMessage already convert a rejecting fetch into
    // {ok:false}. A MALFORMED (non-Response) resolution makes the provider LIBRARY
    // throw inside the sink, so the exception can only be contained by the adapter.
    it.each(PAYLOADS)(
      "contains a provider library that THROWS inside the sink — %s delivery resolves ok:false",
      async (kind, payload) => {
        const { adapter, hits } = c.make({ companion: COMPANION_E164, mode: "malformed" });
        const expected = c.routeWithCompanion[kind];

        const result = await adapter.deliver(payload);
        expect(result).toEqual({ ok: false, via: expected });
        expect(result.via).not.toBe("none");
        expect(hits).toHaveLength(1);
        expect(hits[0].sinkId).toBe(sinkFor(c, expected));
      },
    );

    // TCPA hard rail (§5.1/§5.2) — the destination is OPTED OUT. This is the only
    // assertion that can tell `guardedSendX` from the raw `sendX`: the raw path
    // still produces a provider hit (and an ok:true), the guarded path produces
    // NONE. `via` must still name the REAL route attempted, never collapse to "none".
    it.each(PAYLOADS)(
      "honors the opt-out rail for a %s delivery to an opted-out destination",
      async (kind, payload) => {
        const expected = c.routeWithCompanion[kind];
        const sink = sinkFor(c, expected);
        // Opt out BOTH candidate destinations so the assertion cannot be dodged
        // by addressing the other one.
        const { adapter, hits } = c.make({
          companion: COMPANION_E164,
          optedOut: new Set([PEER_E164, COMPANION_E164]),
        });

        const result = await adapter.deliver(payload);
        expect(result.via).toBe(expected);

        if (GUARDED_SINKS.has(sink)) {
          expect(result.ok).toBe(false);
          // ZERO provider calls — the rail suppressed BEFORE the wire.
          expect(hits).toEqual([]);
        } else {
          // The live-call TTS leg is not store-gated (see Q1 in the header).
          expect(result.ok).toBe(true);
          expectSingleHit(c, hits, expected, payload);
        }
      },
    );

    // The FAIL-CLOSED arm: an opt-out store that THROWS must suppress, not send.
    it.each(PAYLOADS)(
      "fails closed on a %s delivery when the opt-out store throws",
      async (kind, payload) => {
        const expected = c.routeWithCompanion[kind];
        const sink = sinkFor(c, expected);
        const { adapter, hits } = c.make({ companion: COMPANION_E164, storeThrows: true });

        const result = await adapter.deliver(payload);
        expect(result.via).toBe(expected);

        if (GUARDED_SINKS.has(sink)) {
          expect(result.ok).toBe(false);
          expect(hits).toEqual([]);
        } else {
          expect(result.ok).toBe(true);
          expectSingleHit(c, hits, expected, payload);
        }
      },
    );

    // §4.3 — deliver() must resolve against the LIVE `capabilities` object, not a
    // construction-time snapshot. Mutating the row must change the next delivery.
    it("resolves each delivery against the LIVE capabilities object, not a snapshot", async () => {
      const { adapter, hits } = c.make({});
      const payload: DeliveryPayload = { kind: "link", url: LINK_LITERAL };

      // Force the companion decision for every channel (voice already is).
      c.denyInlineLink(adapter.capabilities);

      // No companion bound → fail closed, neither sink fires.
      await expect(adapter.deliver(payload)).resolves.toEqual({ ok: false, via: "none" });
      expect(hits).toEqual([]);

      // Bind the companion on the LIVE row — the same call must now route there.
      adapter.capabilities.companion_text_channel = COMPANION_E164;
      await expect(adapter.deliver(payload)).resolves.toEqual({ ok: true, via: "companion" });
      expectSingleHit(c, hits, "companion", payload);

      // A whitespace-only companion is NOT a deliverable number → fail closed again.
      hits.length = 0;
      adapter.capabilities.companion_text_channel = "   ";
      await expect(adapter.deliver(payload)).resolves.toEqual({ ok: false, via: "none" });
      expect(hits).toEqual([]);
    });

    // An unknown payload kind must be handled UNIFORMLY and fail closed: resolve
    // (never reject) with ok:false and NOTHING on the wire. A kind the adapter does
    // not understand must not become an empty/undefined body sent to a real peer.
    it("fails closed on an unknown payload kind — resolves ok:false with nothing sent", async () => {
      const { adapter, hits } = c.make({ companion: COMPANION_E164 });
      const rogue = {
        kind: "video",
        url: "https://sj.local/clip.mp4",
      } as unknown as DeliveryPayload;

      const result = await adapter.deliver(rogue);
      expect(result.ok).toBe(false);
      expect(hits).toEqual([]);
    });

    // §6.9 — per-session independence: no shared capability object, no shared D0 row.
    it("gives each session its own capability object (no cross-session bleed)", () => {
      const pristineRow = d0Row(c.kind);
      const a = c.make({ companion: COMPANION_E164 }).adapter;
      const b = c.make({ companion: OTHER_COMPANION_E164 }).adapter;

      expect(a.capabilities).not.toBe(b.capabilities);

      a.capabilities.companion_text_channel = "+15550008888";
      a.capabilities.inline_text = false;

      expect(b.capabilities.companion_text_channel).toBe(c.expectedCompanion(OTHER_COMPANION_E164));
      expect(b.capabilities.inline_text).toBe(pristineRow.inline_text);
      // The shared static D0 table itself must be untouched.
      expect(d0Row(c.kind)).toEqual(pristineRow);
    });
  },
);

// ---------------------------------------------------------------------------
// D0 TABLE — the row SET, not just the three rows we happen to know about.
// ---------------------------------------------------------------------------

/** The row set Phase 7 is approved for. Adding a row must be a DELIBERATE, test-visible act. */
// #216: sms + voice removed. SYN-272 R2: sms RESTORED [PRINCIPAL-RULED
// 2026-08-27 supersession]; voice stays removed [CTO-JUDGEMENT #6654].
const APPROVED_CHANNEL_KINDS = ["sms", "whatsapp"];

/**
 * Ids a future channel would plausibly be added under, plus the prototype-chain
 * keys that must never resolve to a truthy non-row. Every one must be `null`.
 */
const NON_ROW_IDS = [
  // #216 put both retired bare ids here; SYN-272 R2 removes bare "sms"
  // (it is a ROW again — asserted in the row-set lock above). Near-miss
  // forms ("SMS", " sms", "sms ") STAY: restoration must never buy a
  // permissive normalization. voice remains a non-row [#6654].
  "voice",
  "email",
  "telegram",
  "slack",
  "discord",
  "signal",
  "imessage",
  "rcs",
  "push",
  "web",
  "fax",
  "messenger",
  "instagram",
  "voicemail",
  "SMS",
  " sms",
  "sms ",
  "",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
];

describe("D0 capability table", () => {
  // The row SET itself is the unit under test. Asserting only the three rows we
  // happen to name would let a fourth row ship unnoticed — `knownChannelIds()` is
  // derived from the table, so this pins the table's CARDINALITY, not a sample.
  it("locks the D0 row SET — adding a channel is a deliberate, test-visible act", () => {
    expect(knownChannelIds().toSorted()).toStrictEqual(APPROVED_CHANNEL_KINDS.toSorted());
    // QG4 F5: the D0 row set and the conformance-case set must move TOGETHER —
    // restoring a channel's row without restoring its behavioral case would
    // otherwise be satisfiable by editing the literal above alone, shipping a
    // live channel with zero adapter coverage.
    expect(knownChannelIds().toSorted()).toStrictEqual(CASES.map((c) => c.kind).toSorted());
  });

  // Driven by knownChannelIds(), NOT by a hard-coded triple: a future fourth row is
  // dragged through the post-BAA invariant automatically, so it cannot ship with
  // phi_approved:true and fail nothing.
  it("holds phi_approved === false for EVERY declared row (post-BAA invariant)", () => {
    const ids = knownChannelIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const row = capabilitiesFor(id);
      expect(row).not.toBeNull();
      expect(row?.phi_approved).toBe(false);
    }
  });

  it("fails closed on every non-row id, including prototype-chain keys", () => {
    for (const id of NON_ROW_IDS) {
      expect(knownChannelIds()).not.toContain(id);
      expect(capabilitiesFor(id)).toBeNull();
    }
  });

  it("returns a FRESH row copy per lookup — no caller can poison the shared table", () => {
    for (const id of knownChannelIds()) {
      const first = capabilitiesFor(id);
      const second = capabilitiesFor(id);
      expect(first).not.toBe(second);
      expect(first).toEqual(second);

      // Poison the copy; the table must be unaffected.
      if (first) {
        first.phi_approved = true;
      }
      expect(capabilitiesFor(id)?.phi_approved).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// #216 — RETIRED CHANNELS FAIL CLOSED AT CONSTRUCTION (the ruling observed
// firing). The adapters remain in-tree; with no D0 row they must refuse to
// exist rather than route on a capability set nobody declared. Valid deps,
// deliberately — the ONLY thing failing these constructions is the row's
// absence.
// ---------------------------------------------------------------------------

describe("#216/SYN-272 — construction gating tracks the row set", () => {
  it("createTwilioSmsAdapter CONSTRUCTS [SYN-272 R2: row restored under the 2026-08-27 supersession]", () => {
    // The #216 pin asserted the throw; the SAME provenance discipline flips
    // it: with the row restored, construction succeeds. The voice pin below
    // still proves the deny-arm exists — the gate discriminates, it did not
    // rot open.
    expect(() =>
      createTwilioSmsAdapter({
        session: { toE164: PEER_E164, companionE164: undefined },
        config: TWILIO_CONFIG,
        store: makeStore(),
        fetchImpl: makeSmsTransport([], "ok"),
      }),
    ).not.toThrow();
  });

  it("createTwilioVoiceAdapter throws: no capability row [CTO-JUDGEMENT #6654 removal]", () => {
    expect(() =>
      createTwilioVoiceAdapter({
        session: { toE164: PEER_E164, companionE164: COMPANION_E164 },
        smsConfig: TWILIO_CONFIG,
        store: makeStore(),
        emitTwiml: makeEmitTwiml([], "ok"),
        fetchImpl: makeSmsTransport([], "ok"),
      }),
    ).toThrow(/no capability row for channel "voice"/);
  });
});

// ---------------------------------------------------------------------------
// TwiML construction (§5.3) — PURE-FUNCTION coverage retained post-#216.
//
// The former voice-adapter extras exercised generateNotifyTwiml THROUGH the
// adapter; with the voice row retired the adapter cannot be constructed (and
// §7 forbids vi.mock), so the artifact coverage moves to the pure function
// directly. Retired WITH the row, restorable with it: the construction-time
// XML-unsafe-voice rejection and the identity()/CallSid-discard assertions —
// both unreachable without an adapter instance (the capability check throws
// first). They return with voice's CASES entry; see git history at this
// commit.
// ---------------------------------------------------------------------------

describe("generateNotifyTwiml — TwiML artifact (§5.3, pure)", () => {
  it("XML-escapes the spoken text — a payload cannot inject TwiML elements", () => {
    const hostile = 'Tom & Jerry <Hangup/> "quoted"';
    const twiml = generateNotifyTwiml(hostile, "alice");
    // Every dangerous character is an entity, and none survives raw inside <Say>.
    expect(twiml).toContain("Tom &amp; Jerry &lt;Hangup/&gt; &quot;quoted&quot;");
    expect(twiml).not.toContain("Tom & Jerry");
    // Exactly ONE real <Hangup/> element — the injected one did not materialize.
    expect(twiml.split("<Hangup/>")).toHaveLength(2);
  });

  it("renders the requested TTS voice into the Say attribute", () => {
    expect(generateNotifyTwiml("hello", "Polly.Joanna")).toContain('voice="Polly.Joanna"');
    expect(generateNotifyTwiml("hello", "alice")).toContain('voice="alice"');
  });

  // QG4 F6 — THE CALLER OBLIGATION, pinned rather than assumed. The `voice`
  // argument is interpolated RAW into the Say attribute (only the message is
  // escaped), so every caller MUST validate it (the retired voice adapter did,
  // via XML_UNSAFE at construction — that guard's test retired with the case).
  // This test documents the sharp edge so it cannot be rediscovered by
  // exploit: if generateNotifyTwiml ever starts escaping the attribute, this
  // goes red and the obligation comments can be deleted. NOTE the second live
  // caller (extensions/voice-call/src/manager/outbound.ts) has NO such guard —
  // raised as a residual in the #216 pr-submit.
  it("does NOT escape the voice attribute — callers must validate it (documented sharp edge)", () => {
    const hostile = '"><Say>pwned</Say><Say voice="x';
    expect(generateNotifyTwiml("hello", hostile)).toContain(`voice="${hostile}"`);
  });
});
