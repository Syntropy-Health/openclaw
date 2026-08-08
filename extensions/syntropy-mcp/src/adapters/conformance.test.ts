import { describe, expect, it, vi } from "vitest";
import type { ResolvedKapsoConfig } from "../../../kapso/src/kapso-config.js";
import type { OptOutStore } from "../../../twilio/src/compliance.js";
import type { ResolvedTwilioSmsConfig } from "../../../twilio/src/config.js";
import type { ChannelAdapter, ChannelCapabilities, DeliveryPayload } from "../channel-adapter.js";
import { capabilitiesFor } from "../channel-capability-config.js";
import { createKapsoWhatsAppAdapter } from "./kapso-whatsapp-adapter.js";
import { createTwilioSmsAdapter } from "./twilio-sms-adapter.js";
import { createTwilioVoiceAdapter } from "./twilio-voice-adapter.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 7 (thin channel adapters: voice / sms / whatsapp).
// Authored from PHASE7-CONTRACT.md + the FROZEN C0 seam ONLY; no adapter
// implementation was read.
//
// Core invariant under challenge: UNIFORMITY (A&D §5.1). Three providers, ONE
// shared body. A channel is allowed to differ in exactly two places — (a) how it
// names an inbound sender and (b) how it physically delivers — and BOTH are
// absorbed as declared capability data by C0. Everything else must be identical,
// so this file is parameterized over a descriptor table and every assertion below
// runs N times against a single body. Three hand-written copies would prove
// nothing; one body that all three satisfy IS the proof.
//
// Two things are asserted together everywhere routing is involved: the `via`
// observable AND which sink actually fired (via a recorded provider hit). `via`
// alone can be faked; a sink call alone hides the honest route. In particular
// `via:"none"` means NOTHING WAS ATTEMPTED (Phase 0 finding F5) — a sink that
// fired and reported failure must KEEP its real route.
//
// House style per contract §7: NO `vi.mock` anywhere. Pure DI — injected
// `fetchImpl` transports, an in-memory OptOutStore literal, a `vi.fn` emitTwiml,
// plain typed config fixtures, zero env mutation.
// ---------------------------------------------------------------------------

// --- shared fixtures --------------------------------------------------------

/** The paired peer: both the inbound SENDER in every fixture and `session.toE164`. */
const PEER_E164 = "+16505551234";
/** Meta's Cloud API delivers `from` as BARE digits — normalization is under test. */
const PEER_BARE_DIGITS = "16505551234";
const COMPANION_E164 = "+15551230001";
const OTHER_COMPANION_E164 = "+15551239999";
const KAPSO_PHONE_NUMBER_ID = "PN_conformance";

const TWILIO_CONFIG: ResolvedTwilioSmsConfig = {
  accountSid: "AC_conformance",
  apiKeySid: "SK_conformance",
  apiKeySecret: "secret_value_never_leak",
  authToken: "authtok_webhook_only",
  smsNumber: "+15550001234",
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

/** In-memory opt-out store; nobody is opted out, so the guarded sends run. */
function makeStore(optedOut: Set<string> = new Set()): OptOutStore {
  return {
    isOptedOut: (e164: string) => optedOut.has(e164),
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
  if (!row) throw new Error(`no D0 row for kind "${kind}" — fixture is wrong`);
  return row;
}

// --- provider fakes ---------------------------------------------------------

/** How the injected provider behaves for one adapter construction. */
type ProviderMode = "ok" | "fail" | "reject";

/** A sink that actually reached a provider: which route it was, and what it carried. */
type Hit = { route: "inline" | "companion"; artifact: string };

/** Which route an outbound destination represents, given the session's companion. */
function routeOfFactory(companion: string | undefined) {
  return (to: string): Hit["route"] =>
    companion !== undefined && to === companion ? "companion" : "inline";
}

/** Twilio REST transport (used as the SMS inline leg AND the voice companion leg). */
function makeSmsTransport(hits: Hit[], companion: string | undefined, mode: ProviderMode) {
  const routeOf = routeOfFactory(companion);
  return vi.fn(async (_url: string, init: RequestInit) => {
    const form = init.body as URLSearchParams;
    hits.push({ route: routeOf(form.get("To") ?? ""), artifact: form.get("Body") ?? "" });
    if (mode === "reject") throw new Error("twilio transport rejected");
    return mode === "fail"
      ? new Response(JSON.stringify({ code: 21211, message: "rejected by carrier" }), {
          status: 400,
        })
      : new Response(JSON.stringify({ sid: "SM_ok", status: "queued" }), { status: 201 });
  }) as unknown as typeof fetch;
}

/** Kapso / Cloud API transport (the WhatsApp inline leg). */
function makeKapsoTransport(hits: Hit[], companion: string | undefined, mode: ProviderMode) {
  const routeOf = routeOfFactory(companion);
  return vi.fn(async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as { to?: string; text?: { body?: string } };
    hits.push({ route: routeOf(payload.to ?? ""), artifact: payload.text?.body ?? "" });
    if (mode === "reject") throw new Error("kapso transport rejected");
    return mode === "fail"
      ? new Response(JSON.stringify({ error: { message: "rejected by cloud api" } }), {
          status: 400,
        })
      : new Response(JSON.stringify({ messages: [{ id: "wamid.OUT" }] }), { status: 200 });
  }) as unknown as typeof fetch;
}

/** The voice inline (TTS) leg — records the TwiML it was handed. */
function makeEmitTwiml(hits: Hit[], mode: ProviderMode) {
  return vi.fn(async (twiml: string): Promise<boolean> => {
    hits.push({ route: "inline", artifact: twiml });
    if (mode === "reject") throw new Error("tts leg rejected");
    return mode !== "fail";
  });
}

// --- native inbound fixtures (REAL provider shapes) -------------------------

/** Twilio webhook form body (voice AND sms): `From` is already E.164. */
function twilioForm(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

const VOICE_CALL_SID = "CA00000000000000000000000000000001";
const SMS_MESSAGE_SID = "SM00000000000000000000000000000001";
const WHATSAPP_WAMID = "wamid.NATIVE0001";

function voiceInbound(sender: string | null): URLSearchParams {
  const fields: Record<string, string> = {
    To: TWILIO_CONFIG.smsNumber,
    CallSid: VOICE_CALL_SID,
    CallStatus: "ringing",
    Direction: "inbound",
  };
  if (sender !== null) fields.From = sender;
  return twilioForm(fields);
}

function smsInbound(sender: string | null): URLSearchParams {
  const fields: Record<string, string> = {
    To: TWILIO_CONFIG.smsNumber,
    MessageSid: SMS_MESSAGE_SID,
    Body: "hi",
    NumMedia: "0",
  };
  if (sender !== null) fields.From = sender;
  return twilioForm(fields);
}

/** Raw Meta/Kapso webhook payload. `from` arrives as BARE digits (no leading "+"). */
function whatsappInbound(sender: string | null): unknown {
  const message: Record<string, unknown> = {
    id: WHATSAPP_WAMID,
    type: "text",
    text: { body: "hi" },
  };
  if (sender !== null) message.from = sender;
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
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

/** A delivery-status-only event: ZERO messages → no single identity → must throw. */
const WHATSAPP_ZERO_MESSAGE_INBOUND = {
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
            statuses: [{ id: WHATSAPP_WAMID, status: "delivered", recipient_id: PEER_BARE_DIGITS }],
          },
        },
      ],
    },
  ],
};

/** Meta coalesces messages: TWO senders in one delivery → ambiguous → must throw. */
const WHATSAPP_TWO_MESSAGE_INBOUND = {
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
            messages: [
              { from: PEER_BARE_DIGITS, id: WHATSAPP_WAMID, type: "text", text: { body: "hi" } },
              { from: "16505559999", id: "wamid.NATIVE0002", type: "text", text: { body: "yo" } },
            ],
          },
        },
      ],
    },
  ],
};

// --- the descriptor table ---------------------------------------------------
//
// Each adapter contributes DATA only: how to build it against fakes, the D0 route
// it must take per payload kind, and its native inbound shapes. All behavior is
// asserted by the single shared body below.

type Harness = {
  adapter: ChannelAdapter;
  /** Provider hits in call order — the ground truth for "which sink fired". */
  hits: Hit[];
};

type AdapterCase = {
  /** The D0 lookup key AND the required `identity().channelId`. */
  kind: string;
  /** Construct the adapter bound to fresh fakes. */
  make: (opts: { companion?: string; mode?: ProviderMode }) => Harness;
  /** What `capabilities.companion_text_channel` must be for a given session companion. */
  expectedCompanion: (sessionCompanion: string | undefined) => string | undefined;
  /** Route each payload kind must take WITH a companion bound. */
  routeWithCompanion: Record<PayloadKind, Hit["route"]>;
  /** Route each payload kind must take with NO companion bound ("none" = fail closed). */
  routeWithoutCompanion: Record<PayloadKind, Hit["route"] | "none">;
  /** A real native inbound whose sender is PEER_E164. */
  nativeInbound: unknown;
  /** The native per-conversation id that fixture carries — MUST be discarded. */
  nativeId: string;
  /** Same native shape with an arbitrary/absent sender (null = the field is omitted). */
  inboundWithSender: (sender: string | null) => unknown;
  /** Further provider-specific inbounds that must fail closed by throwing. */
  extraBadInbounds: Array<[string, unknown]>;
};

const CASES: AdapterCase[] = [
  {
    kind: "voice",
    make: ({ companion, mode = "ok" }) => {
      const hits: Hit[] = [];
      const adapter = createTwilioVoiceAdapter({
        session: { toE164: PEER_E164, companionE164: companion },
        smsConfig: TWILIO_CONFIG,
        store: makeStore(),
        emitTwiml: makeEmitTwiml(hits, mode),
        fetchImpl: makeSmsTransport(hits, companion, mode),
      });
      return { adapter, hits };
    },
    expectedCompanion: (sessionCompanion) => sessionCompanion,
    routeWithCompanion: { text: "inline", link: "companion", otp: "companion" },
    routeWithoutCompanion: { text: "inline", link: "none", otp: "none" },
    nativeInbound: voiceInbound(PEER_E164),
    nativeId: VOICE_CALL_SID,
    inboundWithSender: voiceInbound,
    extraBadInbounds: [["an inbound that is not URLSearchParams", { From: PEER_E164 }]],
  },
  {
    kind: "sms",
    make: ({ companion, mode = "ok" }) => {
      const hits: Hit[] = [];
      const adapter = createTwilioSmsAdapter({
        session: { toE164: PEER_E164, companionE164: companion },
        config: TWILIO_CONFIG,
        store: makeStore(),
        fetchImpl: makeSmsTransport(hits, companion, mode),
      });
      return { adapter, hits };
    },
    expectedCompanion: () => undefined,
    routeWithCompanion: { text: "inline", link: "inline", otp: "inline" },
    routeWithoutCompanion: { text: "inline", link: "inline", otp: "inline" },
    nativeInbound: smsInbound(PEER_E164),
    nativeId: SMS_MESSAGE_SID,
    inboundWithSender: smsInbound,
    extraBadInbounds: [["an inbound that is not URLSearchParams", { From: PEER_E164 }]],
  },
  {
    kind: "whatsapp",
    make: ({ companion, mode = "ok" }) => {
      const hits: Hit[] = [];
      const adapter = createKapsoWhatsAppAdapter({
        session: { toE164: PEER_E164, companionE164: companion },
        config: KAPSO_CONFIG,
        phoneNumberId: KAPSO_PHONE_NUMBER_ID,
        store: makeStore(),
        fetchImpl: makeKapsoTransport(hits, companion, mode),
      });
      return { adapter, hits };
    },
    expectedCompanion: () => undefined,
    routeWithCompanion: { text: "inline", link: "inline", otp: "inline" },
    routeWithoutCompanion: { text: "inline", link: "inline", otp: "inline" },
    nativeInbound: whatsappInbound(PEER_BARE_DIGITS),
    nativeId: WHATSAPP_WAMID,
    inboundWithSender: whatsappInbound,
    extraBadInbounds: [
      ["a delivery-status-only event with ZERO messages", WHATSAPP_ZERO_MESSAGE_INBOUND],
      ["a coalesced delivery with TWO messages (ambiguous)", WHATSAPP_TWO_MESSAGE_INBOUND],
    ],
  },
];

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
      expect(adapter.capabilities).toEqual({
        ...d0Row(c.kind),
        companion_text_channel: c.expectedCompanion(COMPANION_E164),
      });
    });

    it("matches the D0 row exactly when no companion is bound", () => {
      const { adapter } = c.make({});
      expect(adapter.capabilities).toEqual({
        ...d0Row(c.kind),
        companion_text_channel: c.expectedCompanion(undefined),
      });
    });

    // §6.2 — the post-BAA invariant: no channel carries PHI today.
    it("declares phi_approved === false (post-BAA invariant)", () => {
      expect(c.make({ companion: COMPANION_E164 }).adapter.capabilities.phi_approved).toBe(false);
      expect(c.make({}).adapter.capabilities.phi_approved).toBe(false);
    });

    // §6.3 — normalization to E.164 + the channel KIND as channelId.
    it("normalizes the native inbound sender to E.164 and reports the channel KIND", () => {
      const identity = c.make({}).adapter.identity(c.nativeInbound);
      expect(identity.e164).toBe(PEER_E164);
      expect(identity.channelId).toBe(c.kind);
    });

    // §6.4 — the native per-conversation id (CallSid / MessageSid / wamid) is DROPPED.
    it("discards the native per-conversation id — identity is exactly { e164, channelId }", () => {
      const identity = c.make({}).adapter.identity(c.nativeInbound);
      expect(Object.keys(identity).sort()).toEqual(["channelId", "e164"]);
      expect(Object.values(identity)).not.toContain(c.nativeId);
      expect(JSON.stringify(identity)).not.toContain(c.nativeId);
    });

    // §6.5 — an unidentifiable inbound must THROW (the return type is non-nullable,
    // so a bogus identity is the only alternative — and that is unacceptable).
    it.each(BAD_SENDERS)("throws (fails closed) on %s", (_label, sender) => {
      const { adapter } = c.make({});
      expect(() => adapter.identity(c.inboundWithSender(sender))).toThrow();
    });

    it.each(c.extraBadInbounds)("throws (fails closed) on %s", (_label, inbound) => {
      const { adapter } = c.make({});
      expect(() => adapter.identity(inbound)).toThrow();
    });

    // §6.6 — routing is the D0 row resolved by the SHARED resolver. Asserted through
    // BOTH the returned `via` AND which sink actually reached a provider.
    it.each(PAYLOADS)(
      "routes a %s payload per its D0 row (companion bound) — via + sink agree",
      async (kind, payload) => {
        const { adapter, hits } = c.make({ companion: COMPANION_E164 });
        const expected = c.routeWithCompanion[kind];

        await expect(adapter.deliver(payload)).resolves.toEqual({ ok: true, via: expected });

        // Exactly one sink fired, and it was the one `via` claims.
        expect(hits.map((h) => h.route)).toEqual([expected]);
        // Contract §5.1: the payload's literal reaches the wire, no extra prose.
        expect(hits[0].artifact).toContain(literalOf(payload));
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
          expect(hits.map((h) => h.route)).toEqual([expected]);
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
        expect(hits.map((h) => h.route)).toEqual([expected]);
      },
    );

    // §6.8 — a provider that REJECTS must not escape deliver() as an exception.
    it.each(PAYLOADS)(
      "surfaces a rejecting provider as ok:false, never as a thrown %s delivery",
      async (kind, payload) => {
        const { adapter, hits } = c.make({ companion: COMPANION_E164, mode: "reject" });
        const expected = c.routeWithCompanion[kind];

        await expect(adapter.deliver(payload)).resolves.toEqual({ ok: false, via: expected });
        expect(hits.map((h) => h.route)).toEqual([expected]);
      },
    );

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
