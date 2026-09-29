import { describe, expect, it } from "vitest";
import { SHRINEAI_SMS_SIGN_OFF, TWILIO_MAX_BODY_CHARS, withShrineAiSignOff } from "./signoff.js";

describe("ShrineAI SMS sign-off", () => {
  it("is the CEO-GREEN wording, verbatim (ASCII hyphen, CEO #12799)", () => {
    // [PRINCIPAL-RULED 2026-09-29, CTO #12680]: CEO-GREEN sign-off text.
    expect(SHRINEAI_SMS_SIGN_OFF).toBe("- ShrineAI, an AI assistant");
  });

  it("appends the sign-off after one space, as in the registered samples", () => {
    expect(withShrineAiSignOff("Your check-in is logged.")).toBe(
      "Your check-in is logged. - ShrineAI, an AI assistant",
    );
  });

  it("trims trailing whitespace before signing", () => {
    expect(withShrineAiSignOff("Hi there.  \n\n")).toBe("Hi there. - ShrineAI, an AI assistant");
  });

  it("is idempotent: an already-signed body is not signed twice", () => {
    const once = withShrineAiSignOff("Hello");
    expect(withShrineAiSignOff(once)).toBe(once);
  });

  it("an empty reply still carries the identity", () => {
    expect(withShrineAiSignOff("")).toBe("- ShrineAI, an AI assistant");
    expect(withShrineAiSignOff("   ")).toBe("- ShrineAI, an AI assistant");
  });

  it("never exceeds Twilio's 1600-char body limit: the REPLY is trimmed, the sign-off kept", () => {
    const long = "x".repeat(5000);
    const out = withShrineAiSignOff(long);
    expect(out.length).toBeLessThanOrEqual(TWILIO_MAX_BODY_CHARS);
    expect(out.length).toBe(TWILIO_MAX_BODY_CHARS);
    expect(out.endsWith(" - ShrineAI, an AI assistant")).toBe(true);
    expect(out).toContain("... - ShrineAI");
  });

  it("a reply that exactly fits with the sign-off is not truncated", () => {
    const room = TWILIO_MAX_BODY_CHARS - " - ShrineAI, an AI assistant".length;
    const fits = "y".repeat(room);
    const out = withShrineAiSignOff(fits);
    expect(out).toBe(`${fits} - ShrineAI, an AI assistant`);
    expect(out.length).toBe(TWILIO_MAX_BODY_CHARS);
  });

  it("an already-signed over-long body is still fitted to the limit", () => {
    const signedLong = `${"z".repeat(3000)} - ShrineAI, an AI assistant`;
    const out = withShrineAiSignOff(signedLong);
    expect(out.length).toBe(TWILIO_MAX_BODY_CHARS);
    expect(out.endsWith("- ShrineAI, an AI assistant")).toBe(true);
    expect(out.match(/ShrineAI/g)?.length).toBe(1);
  });

  it("never splits an emoji (surrogate pair) at the cut point", () => {
    const out = withShrineAiSignOff(`a${"\u{1F600}".repeat(2000)}`);
    expect(out.length).toBeLessThanOrEqual(TWILIO_MAX_BODY_CHARS);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    const wire = new URLSearchParams(new URLSearchParams({ Body: out }).toString()).get("Body");
    expect(wire).not.toContain("\uFFFD");
  });

  it("an already-signed reply with trailing whitespace is signed exactly once", () => {
    const out = withShrineAiSignOff("Hello - ShrineAI, an AI assistant  \n");
    expect(out).toBe("Hello - ShrineAI, an AI assistant");
  });

  it("the truncation marker is ASCII (does not force UCS-2 on its own)", () => {
    expect(withShrineAiSignOff("x".repeat(3000))).toContain("... ");
  });
});
