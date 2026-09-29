/**
 * REGISTERED A2P 10DLC CAMPAIGN COPY — byte-for-byte pins.
 *
 * Carriers compare what we send against the ShrineAI campaign registration. These
 * tests are the pin the CEO asked for (#12809, relayed by devex #12812; CTO #12807):
 *   1. exact equality per registered string,
 *   2. every outbound template is GSM-7 only (no Smart Encoding on this path),
 *   3. every keyword reply fits one segment (<= 160 chars).
 * The expected strings below are typed from the dispatches, NOT imported from the
 * code under test, so an edit to the code cannot silently move the expectation.
 */
import { describe, expect, it } from "vitest";
import {
  GENERIC_COMPLIANCE_COPY,
  handleInboundCompliance,
  HELP_REPLY,
  OPT_IN_REPLY,
  OPT_OUT_REPLY,
  SMS_CAMPAIGN_COPY,
  type OptOutStore,
} from "./compliance.js";
import { SHRINEAI_SMS_SIGN_OFF, withShrineAiSignOff } from "./signoff.js";

const REGISTERED = {
  optOut:
    "ShrineAI (Shrine Longevity): you're unsubscribed and won't receive more messages. Reply START to resubscribe.",
  optIn:
    "ShrineAI (Shrine Longevity): you're connected. Msg frequency varies; we only reply to you. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  help: "ShrineAI (Shrine Longevity) is an AI assistant for account holders. Help: support@syntropyhealth.bio. Msg & data rates may apply. Reply STOP to opt out.",
  sample1:
    "Hi! Your Shrine Longevity order is being prepared - you'll see an update on your Orders page when it ships. Reply HELP for help or STOP to opt out. - ShrineAI, an AI assistant",
  sample2:
    "Thanks for your message. I can help with questions about your account, orders and the app - open it here: https://shrinelongevity.com/r/start/sms . Reply HELP for help or STOP to opt out. - ShrineAI, an AI assistant",
  signOff: "- ShrineAI, an AI assistant",
} as const;

// GSM 03.38 basic character set + the basic extension table (each extension char
// costs 2 septets but stays GSM-7). Anything outside forces UCS-2 (70 chars/segment).
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "\f^{}\\[~]|€";
const GSM7 = new Set([...GSM7_BASIC, ...GSM7_EXT]);
function nonGsm7(s: string): string[] {
  return [...s].filter((ch) => !GSM7.has(ch));
}

function memStore(): OptOutStore {
  const set = new Set<string>();
  return {
    isOptedOut: async (e) => set.has(e),
    optOut: async (e) => void set.add(e),
    optIn: async (e) => void set.delete(e),
  };
}

describe("registered campaign copy — exact text", () => {
  it("OPT_OUT_REPLY equals the registered STOP reply", () => {
    expect(OPT_OUT_REPLY).toBe(REGISTERED.optOut);
  });
  it("OPT_IN_REPLY equals the registered opt-in / START reply", () => {
    expect(OPT_IN_REPLY).toBe(REGISTERED.optIn);
  });
  it("HELP_REPLY equals the registered HELP reply", () => {
    expect(HELP_REPLY).toBe(REGISTERED.help);
  });
  it("the sign-off equals the registered signature (ASCII hyphen)", () => {
    expect(SHRINEAI_SMS_SIGN_OFF).toBe(REGISTERED.signOff);
  });
  it("signing a sample's body reproduces the registered sample 1 byte-for-byte", () => {
    const body = REGISTERED.sample1.slice(0, -` ${REGISTERED.signOff}`.length);
    expect(withShrineAiSignOff(body)).toBe(REGISTERED.sample1);
  });
  it("signing a sample's body reproduces the registered sample 2 byte-for-byte", () => {
    const body = REGISTERED.sample2.slice(0, -` ${REGISTERED.signOff}`.length);
    expect(withShrineAiSignOff(body)).toBe(REGISTERED.sample2);
  });
});

describe("registered campaign copy — what the SMS path actually SENDS", () => {
  it("STOP / START / HELP through the SMS handler return the registered strings", async () => {
    const store = memStore();
    const stop = await handleInboundCompliance("+15550000001", "STOP", store, SMS_CAMPAIGN_COPY);
    const start = await handleInboundCompliance("+15550000001", "START", store, SMS_CAMPAIGN_COPY);
    const help = await handleInboundCompliance("+15550000001", "HELP", store, SMS_CAMPAIGN_COPY);
    expect(stop).toEqual({ kind: "stop", reply: REGISTERED.optOut });
    expect(start).toEqual({ kind: "start", reply: REGISTERED.optIn });
    expect(help).toEqual({ kind: "help", reply: REGISTERED.help });
  });
  it("keyword replies carry NO agent signature (registered replies are unsigned)", () => {
    for (const s of [OPT_OUT_REPLY, OPT_IN_REPLY, HELP_REPLY]) {
      expect(s).not.toContain(REGISTERED.signOff);
    }
  });
});

describe("GSM-7 charset", () => {
  it("the checker discriminates: it flags an em dash, curly quote and emoji (RED arm)", () => {
    expect(nonGsm7("a — b ’ c \u{1F600}")).toEqual(["—", "’", "\u{1F600}"]);
    expect(nonGsm7("plain - 'ascii' & 100%")).toEqual([]);
  });
  it("every outbound SMS template is GSM-7 only", () => {
    const templates = {
      OPT_OUT_REPLY,
      OPT_IN_REPLY,
      HELP_REPLY,
      SHRINEAI_SMS_SIGN_OFF,
      sample1: withShrineAiSignOff(REGISTERED.sample1),
      sample2: withShrineAiSignOff(REGISTERED.sample2),
      truncated: withShrineAiSignOff("x".repeat(3000)),
    };
    for (const [name, s] of Object.entries(templates)) {
      expect({ name, bad: nonGsm7(s) }).toEqual({ name, bad: [] });
    }
  });
});

describe("single segment", () => {
  it("every keyword reply is <= 160 chars", () => {
    for (const s of [OPT_OUT_REPLY, OPT_IN_REPLY, HELP_REPLY]) {
      expect(s.length).toBeLessThanOrEqual(160);
    }
  });
});

describe("channel isolation", () => {
  it("WhatsApp (generic) copy is untouched by the SMS campaign — the ruling scoped SMS only", () => {
    expect(GENERIC_COMPLIANCE_COPY.stop).toBe(
      "You are unsubscribed from Shrine Longevity messages and will receive no more texts. Reply START to resubscribe.",
    );
    expect(GENERIC_COMPLIANCE_COPY).not.toEqual(SMS_CAMPAIGN_COPY);
  });
});
