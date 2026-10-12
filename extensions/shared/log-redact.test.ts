import { afterEach, describe, expect, test, vi } from "vitest";
import { LOG_REDACT_KEY_ENV, logToken, redactPeer } from "./log-redact.js";

const PHONE = "+19785550123";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("logToken / redactPeer", () => {
  test("keyed: hmac token, stable for one key, never contains the input", () => {
    const a = redactPeer("sms", PHONE, "k1");
    expect(a).toMatch(/^sms:hmac:[0-9a-f]{12}$/);
    expect(a).toBe(redactPeer("sms", PHONE, "k1"));
    expect(a).not.toContain("9785550123");
    expect(redactPeer("sms", "+19785550124", "k1")).not.toBe(a);
  });

  test("the key matters: a different key gives a different token (not a plain hash)", () => {
    expect(logToken(PHONE, "k1")).not.toBe(logToken(PHONE, "k2"));
  });

  test("no key: literal 'redacted', never a hash or the raw value", () => {
    vi.stubEnv(LOG_REDACT_KEY_ENV, "");
    expect(redactPeer("sms", PHONE)).toBe("sms:redacted");
    expect(logToken(PHONE, "   ")).toBe("redacted");
  });

  test("reads the key from the environment at call time", () => {
    vi.stubEnv(LOG_REDACT_KEY_ENV, "envkey");
    expect(logToken(PHONE)).toBe(logToken(PHONE, "envkey"));
  });

  test("empty value -> '-'", () => {
    expect(logToken(undefined, "k1")).toBe("-");
    expect(logToken("  ", "k1")).toBe("-");
  });
});
