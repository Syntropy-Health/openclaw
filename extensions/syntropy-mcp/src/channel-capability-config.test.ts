import { describe, expect, it, vi } from "vitest";
import {
  type ChannelCapabilities,
  deliverViaCapabilities,
  type DeliveryPayload,
} from "./channel-adapter.js";
import { capabilitiesFor, knownChannelIds } from "./channel-capability-config.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 0, Task 0.2 (D0 capability config), amended
// by Phase 7 Task 7.0 (voice.inline_text flip, CTO ruling flag1 #5762) and by
// #216 (2026-08-21): the `sms` and `voice` rows are REMOVED from the table.
//
// #216 PROVENANCE, recorded because the distinction is load-bearing:
//   * sms   — [PRINCIPAL-RULED] "WhatsApp/SMS is a staging-only EXPERIMENT.
//             SMS is OUT OF SCOPE." Reinstating sms needs the ruling revisited
//             AND the E.164/pairing design funded.
//   * voice — [CTO-JUDGEMENT, dispatch #6654] — NOT principal-ruled; the
//             "and voice" in the relay was an inference inside a PRINCIPAL
//             RULED paragraph. Basis: same evidence as sms + SJ's manifests
//             already ship without voice (SJ #1761) + voice is UNPAIRABLE
//             today (not in A7_CHANNELS). REVERSIBLE same-day if a pairing
//             path lands — restore per flag1, whose routing semantics are
//             preserved at the bottom of this file as the reference.
//
// Invariants under challenge:
//   * whatsapp CAN render links + text inline; it is the ONLY row.
//   * sms and voice are DENIED — the fail-closed null is the ruling made
//     load-bearing, not an accident of a missing entry.
//   * phi_approved is false for every remaining row (PHI is post-BAA).
//   * unknown channels FAIL CLOSED (null) — never a permissive default.
// ---------------------------------------------------------------------------

describe("capabilitiesFor — known channels (post-#216: whatsapp is the only row)", () => {
  it("whatsapp renders links and text inline", () => {
    const c = capabilitiesFor("whatsapp");
    expect(c).not.toBeNull();
    expect(c!.inline_link).toBe(true);
    expect(c!.inline_text).toBe(true);
    expect(c!.phi_approved).toBe(false);
  });

  it("whatsapp row is EXACTLY the ruled shape (no extra/renamed fields)", () => {
    expect(capabilitiesFor("whatsapp")).toStrictEqual({
      inline_link: true,
      inline_text: true,
      phi_approved: false,
    });
  });

  it("the table exposes EXACTLY the whatsapp row — nothing snuck back in", () => {
    expect(knownChannelIds()).toEqual(["whatsapp"]);
  });
});

describe("#216 — retired channels are DENIED (the ruling observed firing, not assumed)", () => {
  it("sms resolves to null [PRINCIPAL-RULED: out of scope]", () => {
    expect(capabilitiesFor("sms")).toBeNull();
  });

  it("voice resolves to null [CTO-JUDGEMENT #6654: unpairable today, not principal-ruled]", () => {
    expect(capabilitiesFor("voice")).toBeNull();
  });
});

describe("capabilitiesFor — PHI gate (post-BAA)", () => {
  // The channel set shrank (#216); the PHI invariant did not: EVERY remaining
  // row is phi_approved:false, and flipping one is a separate, deliberate
  // post-BAA change. Iterating knownChannelIds() keeps this exhaustive if a
  // channel is ever added back.
  it("no channel row is phi_approved", () => {
    const ids = knownChannelIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(capabilitiesFor(id)!.phi_approved, id).toBe(false);
    }
  });
});

describe("capabilitiesFor — unknown channels fail closed", () => {
  // #216 note: bare "sms"/"voice" now also resolve null (asserted above, with
  // their provenance labels). The near-miss forms below were ALWAYS unknown —
  // removing rows must never buy a permissive normalization either.
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
    "Whatsapp",
    " whatsapp",
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
// T2 [HIGH]: capabilitiesFor returns a FRESH copy per call — a caller that
// mutates its row (e.g. binding a per-session field) must not mutate the shared
// table or any other caller's row. Exercised on whatsapp, the remaining row.
// ---------------------------------------------------------------------------

describe("capabilitiesFor — fresh-copy isolation", () => {
  it("two calls for the same channel return distinct objects", () => {
    const a = capabilitiesFor("whatsapp");
    const b = capabilitiesFor("whatsapp");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("mutating one result does not affect another call", () => {
    const a = capabilitiesFor("whatsapp")!;
    const b = capabilitiesFor("whatsapp")!;
    a.inline_link = false;
    const c = capabilitiesFor("whatsapp")!;
    expect(b.inline_link).toBe(true);
    expect(c.inline_link).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// flag1 (#5762) ROUTING SEMANTICS — preserved as the REVERSIBILITY REFERENCE.
//
// HISTORY OF THIS BLOCK, because its sourcing deliberately INVERTED at #216:
// while the voice row shipped, these tests drove deliverViaCapabilities with
// the row from capabilitiesFor("voice") — "the real table produces the
// routing, not a literal". Post-#216 the SHIPPED fact is the row's ABSENCE
// (asserted above, with provenance labels), so these now drive the resolver
// with FLAG1_VOICE_ROW, a literal carrying the flag1-ruled shape. Two reasons
// this block survives the row it tested:
//   1. deliverViaCapabilities is CHANNEL-AGNOSTIC and still shipped — this is
//      its only coverage of the inline_text:true / inline_link:false split.
//   2. voice's removal is [CTO-JUDGEMENT], explicitly REVERSIBLE: if voice
//      returns, it must return to THIS ruled behavior — not to the A&D §3
//      row (inline_text:false) that flag1 superseded. A future restoration
//      flips these tests back to shipped-row sourcing.
//
// The matrix:
//   text + companion    → INLINE     (flag1: TTS speaks it)
//   link + companion    → COMPANION  (a call can't render a URL)
//   otp  + companion    → COMPANION  (a call can't render a code)
//   link/otp, NO companion → FAIL-CLOSED via:"none", neither sink
//   text, NO companion  → INLINE     (flag1 closed this fail-closed hole)
// ---------------------------------------------------------------------------

const VOICE_COMPANION_E164 = "+15551230042";

/** The flag1-ruled voice shape. See the block comment: a LITERAL, deliberately. */
const FLAG1_VOICE_ROW: ChannelCapabilities = {
  inline_link: false,
  inline_text: true,
  phi_approved: false,
  companion_text_channel: undefined,
};

/** Records which sink fired and with what args; each sink resolves true (delivered). */
function makeSinks() {
  const inline = vi.fn(async (_p: DeliveryPayload): Promise<boolean> => true);
  const companion = vi.fn(async (_toE164: string, _p: DeliveryPayload): Promise<boolean> => true);
  return { inline, companion };
}

function flag1VoiceCaps(companion?: string): ChannelCapabilities {
  return companion === undefined
    ? { ...FLAG1_VOICE_ROW }
    : { ...FLAG1_VOICE_ROW, companion_text_channel: companion };
}

describe("flag1 voice shape × deliverViaCapabilities — routing (reversibility reference)", () => {
  it("text (companion set) → INLINE; companion sink never called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "text", text: "Your appointment is confirmed." };

    const result = await deliverViaCapabilities(
      flag1VoiceCaps(VOICE_COMPANION_E164),
      payload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "inline" });
    expect(sinks.inline).toHaveBeenCalledTimes(1);
    expect(sinks.inline).toHaveBeenCalledWith(payload);
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  it("link (companion set) → COMPANION at the E.164; inline never called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "link", url: "https://sj.local/verify?t=abc" };

    const result = await deliverViaCapabilities(
      flag1VoiceCaps(VOICE_COMPANION_E164),
      payload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "companion" });
    expect(sinks.companion).toHaveBeenCalledTimes(1);
    expect(sinks.companion).toHaveBeenCalledWith(VOICE_COMPANION_E164, payload);
    expect(sinks.inline).not.toHaveBeenCalled();
  });

  it("otp (companion set) → COMPANION at the E.164; inline never called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "otp", code: "123456" };

    const result = await deliverViaCapabilities(
      flag1VoiceCaps(VOICE_COMPANION_E164),
      payload,
      sinks,
    );

    expect(result).toEqual({ ok: true, via: "companion" });
    expect(sinks.companion).toHaveBeenCalledTimes(1);
    expect(sinks.companion).toHaveBeenCalledWith(VOICE_COMPANION_E164, payload);
    expect(sinks.inline).not.toHaveBeenCalled();
  });

  it("link with NO companion → FAIL-CLOSED via:'none'; NEITHER sink called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "link", url: "https://sj.local/verify?t=abc" };

    const result = await deliverViaCapabilities(flag1VoiceCaps(), payload, sinks);

    expect(result).toEqual({ ok: false, via: "none" });
    expect(sinks.inline).not.toHaveBeenCalled();
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  it("otp with NO companion → FAIL-CLOSED via:'none'; NEITHER sink called", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "otp", code: "123456" };

    const result = await deliverViaCapabilities(flag1VoiceCaps(), payload, sinks);

    expect(result).toEqual({ ok: false, via: "none" });
    expect(sinks.inline).not.toHaveBeenCalled();
    expect(sinks.companion).not.toHaveBeenCalled();
  });

  it("text with NO companion → still INLINE (flag1 closed the fail-closed hole)", async () => {
    const sinks = makeSinks();
    const payload: DeliveryPayload = { kind: "text", text: "You are now signed in." };

    const result = await deliverViaCapabilities(flag1VoiceCaps(), payload, sinks);

    expect(result).toEqual({ ok: true, via: "inline" });
    expect(sinks.inline).toHaveBeenCalledTimes(1);
    expect(sinks.inline).toHaveBeenCalledWith(payload);
    expect(sinks.companion).not.toHaveBeenCalled();
    expect(result.via).not.toBe("none");
    expect(result.via).not.toBe("companion");
  });
});
