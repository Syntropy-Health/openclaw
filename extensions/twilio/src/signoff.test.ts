import { describe, expect, it } from "vitest";
import { SHRINEAI_SMS_SIGN_OFF, TWILIO_MAX_BODY_CHARS, withShrineAiSignOff } from "./signoff.js";

describe("ShrineAI SMS sign-off", () => {
  it("is the CEO-GREEN wording, verbatim", () => {
    // [PRINCIPAL-RULED 2026-09-29, CTO #12680]: CEO-GREEN sign-off text.
    expect(SHRINEAI_SMS_SIGN_OFF).toBe("— ShrineAI, an AI assistant");
  });

  it("appends the sign-off on its own line after the reply", () => {
    expect(withShrineAiSignOff("Your check-in is logged.")).toBe(
      "Your check-in is logged.\n\n— ShrineAI, an AI assistant",
    );
  });

  it("trims trailing whitespace before signing", () => {
    expect(withShrineAiSignOff("Hi there.  \n\n")).toBe("Hi there.\n\n— ShrineAI, an AI assistant");
  });

  it("is idempotent: an already-signed body is not signed twice", () => {
    const once = withShrineAiSignOff("Hello");
    expect(withShrineAiSignOff(once)).toBe(once);
  });

  it("an empty reply still carries the identity", () => {
    expect(withShrineAiSignOff("")).toBe("— ShrineAI, an AI assistant");
    expect(withShrineAiSignOff("   ")).toBe("— ShrineAI, an AI assistant");
  });

  it("never exceeds Twilio's 1600-char body limit: the REPLY is trimmed, the sign-off kept", () => {
    const long = "x".repeat(5000);
    const out = withShrineAiSignOff(long);
    expect(out.length).toBeLessThanOrEqual(TWILIO_MAX_BODY_CHARS);
    expect(out.length).toBe(TWILIO_MAX_BODY_CHARS);
    expect(out.endsWith("\n\n— ShrineAI, an AI assistant")).toBe(true);
    expect(out).toContain("…\n\n— ShrineAI");
  });

  it("a reply that exactly fits with the sign-off is not truncated", () => {
    const room = TWILIO_MAX_BODY_CHARS - "\n\n— ShrineAI, an AI assistant".length;
    const fits = "y".repeat(room);
    const out = withShrineAiSignOff(fits);
    expect(out).toBe(`${fits}\n\n— ShrineAI, an AI assistant`);
    expect(out.length).toBe(TWILIO_MAX_BODY_CHARS);
  });

  it("an already-signed over-long body is still fitted to the limit", () => {
    const signedLong = `${"z".repeat(3000)}\n\n— ShrineAI, an AI assistant`;
    const out = withShrineAiSignOff(signedLong);
    expect(out.length).toBe(TWILIO_MAX_BODY_CHARS);
    expect(out.endsWith("— ShrineAI, an AI assistant")).toBe(true);
    expect(out.match(/ShrineAI/g)?.length).toBe(1);
  });
});
