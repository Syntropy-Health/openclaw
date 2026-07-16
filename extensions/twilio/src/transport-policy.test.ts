import { describe, expect, it } from "vitest";
import { assertTransportAllowed, isCutoverComplete } from "./transport-policy.js";

describe("assertTransportAllowed — dormant prod-reject", () => {
  it("is DORMANT pre-cutover: baileys in prod is allowed while cutoverComplete=false", () => {
    expect(() =>
      assertTransportAllowed({ transport: "baileys", env: "prod", cutoverComplete: false }),
    ).not.toThrow();
  });

  it("post-cutover: REJECTS baileys in prod (WABA is the sanctioned path)", () => {
    expect(() =>
      assertTransportAllowed({ transport: "baileys", env: "prod", cutoverComplete: true }),
    ).toThrow(/baileys.*rejected in prod/i);
  });

  it("post-cutover: allows twilio-waba in prod", () => {
    expect(() =>
      assertTransportAllowed({ transport: "twilio-waba", env: "prod", cutoverComplete: true }),
    ).not.toThrow();
  });

  it("post-cutover: allows baileys OUTSIDE prod (test/dev) — reject is prod-only", () => {
    for (const env of ["test", "dev", "staging"]) {
      expect(() =>
        assertTransportAllowed({ transport: "baileys", env, cutoverComplete: true }),
      ).not.toThrow();
    }
  });
});

describe("isCutoverComplete", () => {
  it("defaults false (dormant) when the env var is unset", () => {
    expect(isCutoverComplete({})).toBe(false);
  });
  it("is true only for the exact 'true' value", () => {
    expect(isCutoverComplete({ WABA_CUTOVER_COMPLETE: "true" })).toBe(true);
    expect(isCutoverComplete({ WABA_CUTOVER_COMPLETE: "1" })).toBe(false);
    expect(isCutoverComplete({ WABA_CUTOVER_COMPLETE: "TRUE" })).toBe(false);
  });
});
