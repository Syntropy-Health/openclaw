import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "./channel-capability-config.js";

// ---------------------------------------------------------------------------
// SEALED challenge suite — Phase 0, Task 0.2 (D0 capability config).
// Authored from the FROZEN interface contract ONLY; no implementation was read.
//
// Invariants under challenge:
//   * voice cannot render links/text inline (inline_link=false, inline_text=false).
//   * sms + whatsapp CAN render inline.
//   * phi_approved is false for ALL three channels today (PHI channel is post-BAA).
//   * unknown channels FAIL CLOSED (null) — never a permissive default.
// ---------------------------------------------------------------------------

describe("capabilitiesFor — known channels", () => {
  it("voice cannot render links or text inline", () => {
    const c = capabilitiesFor("voice");
    expect(c).not.toBeNull();
    expect(c!.inline_link).toBe(false);
    expect(c!.inline_text).toBe(false);
    expect(c!.phi_approved).toBe(false);
    // Voice must have a companion text path to be able to deliver a link at all —
    // present (a set E.164) or explicitly configurable (a string field).
    expect("companion_text_channel" in c!).toBe(true);
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

describe("capabilitiesFor — PHI gate (post-BAA)", () => {
  it.each(["voice", "sms", "whatsapp"])(
    "phi_approved is false for %s (no channel is PHI-approved today)",
    (channel) => {
      const c = capabilitiesFor(channel);
      expect(c).not.toBeNull();
      expect(c!.phi_approved).toBe(false);
    },
  );
});

describe("capabilitiesFor — unknown channels fail closed", () => {
  it.each(["telegram", "", "SMS", "voice ", "slack", "unknown"])(
    "returns null (never permissive) for unknown/malformed channel %o",
    (channel) => {
      expect(capabilitiesFor(channel)).toBeNull();
    },
  );
});
