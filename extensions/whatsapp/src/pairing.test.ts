/**
 * SYN-272 P1 — the WhatsApp pairing adapter's normalizeAllowEntry
 * (CTO ruling #8091; sibling of extensions/twilio/src/pairing.test.ts).
 *
 * The WA adapter EXISTED (idLabel) but had NO normalizeAllowEntry — so the
 * pairing store kept raw-trimmed entries while the dock's
 * config.formatAllowFrom normalized via normalizeWhatsAppTarget: TWO
 * normalization truths for one channel, one of them the identity function.
 * This binds the pairing-store path to the SAME normalizer the dock uses.
 */

import { describe, expect, it } from "vitest";
import { whatsappPlugin } from "./channel.js";

describe("SYN-272 P1 — whatsapp pairing normalizeAllowEntry", () => {
  it("the adapter declares a normalizer (raw trim is two truths against the dock)", () => {
    expect(whatsappPlugin.pairing?.normalizeAllowEntry).toBeDefined();
  });

  it("RED-ARM (cross-format): formatted numbers + prefixed forms normalize to the canonical target", () => {
    const normalize = whatsappPlugin.pairing!.normalizeAllowEntry!;
    for (const [entry, want] of [
      ["+1 (555) 123-4567", "+15551234567"],
      ["whatsapp:+15551234567", "+15551234567"],
      ["  +15551234567  ", "+15551234567"],
    ] as const) {
      expect(normalize(entry), entry).toBe(want);
    }
  });

  it("a group JID passes through canonically (never mangled into a phone shape)", () => {
    const normalize = whatsappPlugin.pairing!.normalizeAllowEntry!;
    expect(normalize("120363000000000000@g.us")).toBe("120363000000000000@g.us");
  });
});
