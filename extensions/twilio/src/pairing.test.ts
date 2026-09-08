/**
 * SYN-272 P1 — the SMS pairing adapter (CTO ruling, dispatch #8091).
 *
 * THE GAP THIS CLOSES (precondition-sheet risk finding): with no
 * `pairing` adapter on the sms plugin, (1) `listPairingChannels()` — which
 * filters on `plugin.pairing` — did not enumerate sms as pairable AT ALL,
 * and (2) `normalizeAllowEntry` fell back to raw trim, so an allowFrom
 * stored as "+1 (555) 123-4567" could never match an inbound normalized to
 * "+15551234567": pairing looks paired, inbound looks refused, every suite
 * green.
 *
 * Per the ruling, the CROSS-FORMAT arm is the point: these tests assert on
 * REAL formatted-vs-E.164 values, and were observed RED against the
 * adapterless plugin before the adapter landed (store formatted → normalize
 * → must equal the E.164 the inbound path produces). A test that passes
 * both with and without the adapter is not measuring the adapter.
 */

import { describe, expect, it } from "vitest";
import { createSmsPlugin } from "./channel.js";
import type { OptOutStore } from "./compliance.js";

const STORE: OptOutStore = { isOptedOut: () => false, optOut: () => {}, optIn: () => {} };

function plugin() {
  return createSmsPlugin({ store: STORE });
}

describe("SYN-272 P1 — sms pairing adapter", () => {
  it("the sms plugin DECLARES pairing (listPairingChannels filters on this — without it sms is unpairable)", () => {
    expect(plugin().pairing).toBeDefined();
  });

  it("idLabel names the identity kind (a phone, not a generic userId)", () => {
    expect(plugin().pairing!.idLabel.toLowerCase()).toContain("phone");
  });

  it("RED-ARM (cross-format): every human-formatted entry normalizes to the EXACT E.164 the inbound path produces", () => {
    // These are the real-world shapes that raw trim preserved verbatim and
    // could therefore never match a normalized inbound sender.
    const normalize = plugin().pairing!.normalizeAllowEntry!;
    for (const [formatted, e164] of [
      ["+1 (555) 123-4567", "+15551234567"],
      ["1-555-123-4567", "+15551234567"],
      ["+44 20 7946 0958", "+442079460958"],
      ["  +15551234567  ", "+15551234567"],
    ] as const) {
      expect(normalize(formatted), formatted).toBe(e164);
    }
  });

  it("an already-E.164 entry is a fixed point (normalization is idempotent)", () => {
    const normalize = plugin().pairing!.normalizeAllowEntry!;
    expect(normalize(normalize("+1 (555) 123-4567"))).toBe("+15551234567");
  });
});
