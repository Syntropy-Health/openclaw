import { describe, expect, it, vi } from "vitest";
import {
  type ChannelCapabilities,
  deliverViaCapabilities,
  type DeliveryPayload,
} from "./channel-adapter.js";
import { capabilitiesFor } from "./channel-capability-config.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 0, Task 0.2 (D0 capability config).
// Authored from the FROZEN interface contract ONLY; no implementation was read.
//
// Invariants under challenge:
//   * voice cannot render links inline (inline_link=false) but CAN speak plain
//     text inline (inline_text=true — see the Phase 7 / Task 7.0 block below).
//   * sms + whatsapp CAN render inline.
//   * phi_approved is false for ALL three channels today (PHI channel is post-BAA).
//   * unknown channels FAIL CLOSED (null) — never a permissive default.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 7, Task 7.0 (D0 voice.inline_text flip).
// Authored from the CTO ruling (flag1, dispatch #5762) which SUPERSEDES the
// A&D §3 D0 table row for `voice`. No implementation was read.
//
// THE RULING / invariant under challenge:
//   A voice call's TTS IS a real inline TEXT sink — the assistant literally
//   SPEAKS plain text to the caller. So `voice.inline_text` MUST be TRUE.
//   What a voice call genuinely cannot render is a clickable LINK or a readable
//   OTP CODE, so `voice.inline_link` MUST STAY FALSE and link/otp must keep
//   falling back to the paired companion SMS number.
//
// The three things this block challenges:
//   1. The flip HAPPENED     — voice.inline_text === true.
//   2. The flip did NOT OVER-APPLY — voice.inline_link is still false; the sms
//      and whatsapp rows are byte-for-byte unchanged; phi_approved stays false
//      on all three rows (post-BAA, not this phase); fail-closed still holds.
//   3. The flip CHANGED ROUTING for real — asserted end-to-end through
//      deliverViaCapabilities against the SHIPPED voice row (obtained from
//      capabilitiesFor("voice"), never hand-built), because the point is that
//      the real table produces the routing, not that a literal does.
// ---------------------------------------------------------------------------

describe("capabilitiesFor — known channels", () => {
  it("voice speaks plain text inline (TTS) but cannot render a link inline", () => {
    const c = capabilitiesFor("voice");
    expect(c).not.toBeNull();
    // CTO ruling (flag1 #5762): TTS is a real inline TEXT sink.
    expect(c!.inline_text).toBe(true);
    // ...and the flip must NOT over-apply: a call still cannot render a URL/OTP.
    expect(c!.inline_link).toBe(false);
    expect(c!.phi_approved).toBe(false);
    // Voice must have a companion text path to be able to deliver a link at all —
    // present (a set E.164) or explicitly configurable (a string field).
    expect("companion_text_channel" in c!).toBe(true);
  });

  it("voice row is EXACTLY the ruled shape (no extra/renamed fields)", () => {
    expect(capabilitiesFor("voice")).toStrictEqual({
      inline_link: false,
      inline_text: true,
      phi_approved: false,
      companion_text_channel: undefined,
    });
  });

  it("sms renders links and text inline", () => {
    const c = capabilitiesFor("sms");
    expect(c).not.toBeNull();
    expect(c!.inline_link).toBe(true);
    expect(c!.inline_text).toBe(true);
    expect(c!.phi_approved).toBe(false);
  });

  it("whatsapp renders links and text inline", () => {
    const c = capabilitiesFor("whatsapp");
    expect(c).not.toBeNull();
    expect(c!.inline_link).toBe(true);
    expect(c!.inline_text).toBe(true);
    expect(c!.phi_approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 7.0 regression guard — the voice.inline_text flip touches the VOICE ROW
// ONLY. sms and whatsapp are UNCHANGED by the ruling; an over-broad edit (e.g.
// a blanket "inline_text: true" sweep that also nudged inline_link, or a copy
// of the voice row into a sibling) is caught here as an exact-shape mismatch.
// ---------------------------------------------------------------------------

describe("capabilitiesFor — sms/whatsapp unchanged by the voice flip", () => {
  it("sms row is exactly unchanged", () => {
    expect(capabilitiesFor("sms")).toStrictEqual({
      inline_link: true,
      inline_text: true,
      phi_approved: false,
    });
  });

  it("whatsapp row is exactly unchanged", () => {
    expect(capabilitiesFor("whatsapp")).toStrictEqual({
      inline_link: true,
      inline_text: true,
      phi_approved: false,
    });
  });

  it.each(["sms", "whatsapp"])(
    "%s keeps inline_link=true (the voice flip must not have knocked it down)",
    (channel) => {
      expect(capabilitiesFor(channel)!.inline_link).toBe(true);
    },
  );
});

describe("capabilitiesFor — PHI gate (post-BAA)", () => {
  it.each(["voice", "sms", "whatsapp"])(
    "phi_approved is false for %s (no channel is PHI-approved today)",
    (channel) => {
      const c = capabilitiesFor(channel);
      expect(c).not.toBeNull();
      expect(c!.phi_approved).toBe(false);
    },
  );

  // Task 7.0: the inline_text flip is an inline-RENDERING ruling, not a PHI
  // ruling. phi_approved stays false on EVERY row — flipping it is a separate,
  // deliberate post-BAA change. This guards the invariant against drift while
  // the voice row is being edited.
  it("no channel row is phi_approved (the flip must not have touched the PHI gate)", () => {
    const rows = ["voice", "sms", "whatsapp"].map((id) => capabilitiesFor(id));
    expect(rows.every((r) => r !== null)).toBe(true);
    expect(rows.map((r) => r!.phi_approved)).toEqual([false, false, false]);
  });
});

describe("capabilitiesFor — unknown channels fail closed", () => {
  // Task 7.0: the voice row changed, but the LOOKUP did not — a near-miss voice
  // key ("Voice", "VOICE", " voice", "voice\t") is still an UNKNOWN channel and
  // must resolve to null. Editing a row must never buy a permissive normalization.
  it.each([
    "telegram",
    "",
    "SMS",
    "voice ",
    " voice",
    "voice\t",
    "Voice",
    "VOICE",
    "slack",
    "unknown",
  ])("returns null (never permissive) for unknown/malformed channel %o", (channel) => {
    expect(capabilitiesFor(channel)).toBeNull();
  });

  // F1 [CRITICAL]: prototype-chain keys must not leak an Object.prototype hit as
  // a non-null (and empty/permissive) capability row. Every one of these is an
  // UNKNOWN channel and MUST fail closed to null.
  it.each([
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ])("returns null for prototype-chain key %o (no Object.prototype leak)", (channel) => {
    expect(capabilitiesFor(channel)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T2 [HIGH]: capabilitiesFor returns a FRESH copy per call — a caller that sets
// companion_text_channel per session must not mutate the shared table or any
// other caller's row.
// ---------------------------------------------------------------------------

describe("capabilitiesFor — fresh-copy isolation", () => {
  it("two calls for the same channel return distinct objects", () => {
    const a = capabilitiesFor("voice");
    const b = capabilitiesFor("voice");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("mutating one result's companion_text_channel does not affect another call", () => {
    const a = capabilitiesFor("voice")!;
    const b = capabilitiesFor("voice")!;
    a.companion_text_channel = "+15551239999";
    const c = capabilitiesFor("voice")!;
    expect(b.companion_text_channel).toBeUndefined();
    expect(c.companion_text_channel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 7.0 ROUTING — the BEHAVIORAL consequence of the voice.inline_text flip.
//
// These drive the SHARED resolver (deliverViaCapabilities) with the SHIPPED
// voice row — obtained from capabilitiesFor("voice"), never hand-built — so the
// proof is "the real D0 table produces this routing", not "a literal does". A
// hand-built row would pass even if the table were never flipped.
//
// Every case asserts the route TWICE: through the returned `via` AND through
// which sink was / was NOT called. `via` alone is a weaker proof — it cannot
// distinguish "routed inline" from "reported inline while also poking companion".
//
// The matrix (voice only; sms/whatsapp are inline for everything):
//   text + companion  → INLINE     (NEW: pre-flip this went to companion)
//   link + companion  → COMPANION  (unchanged — a call can't render a URL)
//   otp  + companion  → COMPANION  (unchanged — a call can't render a code)
//   link + NO companion → FAIL-CLOSED via:"none", neither sink
//   text + NO companion → INLINE   (NEW: the flip closed a fail-closed HOLE —
//                                   plain speech no longer needs an SMS pair)
// ---------------------------------------------------------------------------

const VOICE_COMPANION_E164 = "+15551230042";

/** Records which sink fired and with what args; each sink resolves true (delivered). */
function makeSinks() {
  const inline = vi.fn(async (_p: DeliveryPayload): Promise<boolean> => true);
  const companion = vi.fn(async (_toE164: string, _p: DeliveryPayload): Promise<boolean> => true);
  return { inline, companion };
}

/**
 * The SHIPPED voice row, optionally with a per-session companion bound (exactly
 * how a real adapter wires it at wire time). Deliberately NOT a literal — the
 * inline_link / inline_text values come from the D0 table under challenge.
 */
function shippedVoiceCaps(companion?: string): ChannelCapabilities {
  const row = capabilitiesFor("voice");
  expect(row).not.toBeNull();
  return companion === undefined ? row! : { ...row!, companion_text_channel: companion };
}

describe("D0 voice row × deliverViaCapabilities — routing after the inline_text flip", () => {
  // (a) THE NEW BEHAVIOR. Pre-flip this landed on the companion SMS; post-ruling
  // the TTS speaks it and the companion must stay untouched.
  it("text over voice (companion set) → INLINE; companion sink never called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "text", text: "Your appointment is confirmed." };

    const result = await deliverViaCapabilities(
      shippedVoiceCaps(VOICE_COMPANION_E164),
      payload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "inline" });
    expect(sinks.inline).toHaveBeenCalledTimes(1);
    expect(sinks.inline).toHaveBeenCalledWith(payload);
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  // (b) UNCHANGED: a call cannot render a clickable URL → paired SMS.
  it("link over voice (companion set) → COMPANION at the E.164; inline never called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "link", url: "https://sj.local/verify?t=abc" };

    const result = await deliverViaCapabilities(
      shippedVoiceCaps(VOICE_COMPANION_E164),
      payload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "companion" });
    expect(sinks.companion).toHaveBeenCalledTimes(1);
    expect(sinks.companion).toHaveBeenCalledWith(VOICE_COMPANION_E164, payload);
    expect(sinks.inline).not.toHaveBeenCalled();
  });

  // (c) UNCHANGED: an OTP code is not speakable-as-readable → paired SMS.
  it("otp over voice (companion set) → COMPANION at the E.164; inline never called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "otp", code: "123456" };

    const result = await deliverViaCapabilities(
      shippedVoiceCaps(VOICE_COMPANION_E164),
      payload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "companion" });
    expect(sinks.companion).toHaveBeenCalledTimes(1);
    expect(sinks.companion).toHaveBeenCalledWith(VOICE_COMPANION_E164, payload);
    expect(sinks.inline).not.toHaveBeenCalled();
  });

  // (d) The flip must NOT have widened link/otp into an inline path: with no
  // companion there is still NO route for a link, and it must fail closed.
  it("link over voice with NO companion → FAIL-CLOSED via:'none'; NEITHER sink called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "link", url: "https://sj.local/verify?t=abc" };

    const result = await deliverViaCapabilities(shippedVoiceCaps(), payload, sinks);

    expect(result).toEqual({ ok: false, via: "none" });
    expect(sinks.inline).not.toHaveBeenCalled();
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  it("otp over voice with NO companion → FAIL-CLOSED via:'none'; NEITHER sink called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "otp", code: "123456" };

    const result = await deliverViaCapabilities(shippedVoiceCaps(), payload, sinks);

    expect(result).toEqual({ ok: false, via: "none" });
    expect(sinks.inline).not.toHaveBeenCalled();
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  // (e) THE POINT OF THE RULING: an unpaired voice call could previously not
  // deliver plain text AT ALL (fail-closed hole). Post-flip it speaks it.
  it("text over voice with NO companion → still INLINE (the flip closed the fail-closed hole)", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "text", text: "You are now signed in." };

    const result = await deliverViaCapabilities(shippedVoiceCaps(), payload, sinks);

    expect(result).toEqual({ ok: true, via: "inline" });
    expect(sinks.inline).toHaveBeenCalledTimes(1);
    expect(sinks.inline).toHaveBeenCalledWith(payload);
    expect(sinks.companion).not.toHaveBeenCalled();
    // Explicitly NOT the pre-flip observable.
    expect(result.via).not.toBe("none");
    expect(result.via).not.toBe("companion");
  });
});
