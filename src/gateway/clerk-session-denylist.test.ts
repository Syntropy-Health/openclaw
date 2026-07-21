import { afterEach, describe, expect, it } from "vitest";
import {
  clearClerkSessionDenylist,
  denyClerkSession,
  isClerkSessionDenied,
} from "./clerk-session-denylist.js";

describe("clerk session deny-list (G-lane [G2b])", () => {
  afterEach(() => clearClerkSessionDenylist());

  it("denies a sid after denyClerkSession; unknown sids are not denied", () => {
    denyClerkSession("sess_1");
    expect(isClerkSessionDenied("sess_1")).toBe(true);
    expect(isClerkSessionDenied("sess_other")).toBe(false);
  });

  it("absent/undefined sid is never denied (tokens without sid pass through)", () => {
    expect(isClerkSessionDenied(undefined)).toBe(false);
    expect(isClerkSessionDenied("")).toBe(false);
  });

  it("★ entries self-expire after their TTL", () => {
    denyClerkSession("sess_ttl", 1); // 1ms TTL
    // Busy-wait a couple ms without timers (deterministic in CI).
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    expect(isClerkSessionDenied("sess_ttl")).toBe(false);
  });

  it("empty sid deny is a no-op", () => {
    denyClerkSession("   ");
    expect(isClerkSessionDenied("   ")).toBe(false);
  });

  it("clear() empties the list", () => {
    denyClerkSession("sess_1");
    clearClerkSessionDenylist();
    expect(isClerkSessionDenied("sess_1")).toBe(false);
  });
});

describe("cross-module identity (Symbol.for global backing)", () => {
  afterEach(() => clearClerkSessionDenylist());

  it("★ the store lives on globalThis[Symbol.for(...)] — a second module instance shares it", () => {
    denyClerkSession("sess_shared");
    const g = globalThis as unknown as Record<symbol, Map<string, number>>;
    const map = g[Symbol.for("openclaw.clerkSessionDenylist")];
    expect(map?.has("sess_shared")).toBe(true); // writer + any reader hit ONE map per process
  });

  it("trim symmetry: deny('x ') is found by check(' x')", () => {
    denyClerkSession("sess_ws ");
    expect(isClerkSessionDenied(" sess_ws")).toBe(true);
  });
});
