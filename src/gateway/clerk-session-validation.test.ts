import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearClerkSessionCache,
  evictClerkSessionCache,
  resolveSessionCacheTtlMs,
  validateClerkSession,
  type ClerkSessionResolver,
  type ResolvedSession,
} from "./clerk-session-validation.js";

const SUB = "user_2abc";
const SID = "sess_1";

/** A resolver that returns a fixed result and records how often it was called. */
function resolver(result: ResolvedSession): ClerkSessionResolver & { calls: number } {
  const fn = vi.fn(async () => result) as unknown as ClerkSessionResolver & { calls: number };
  Object.defineProperty(fn, "calls", {
    get: () => (fn as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
  });
  return fn;
}

afterEach(() => clearClerkSessionCache());

describe("validateClerkSession — §7.4b-A fail-policy", () => {
  it("ACTIVE + sub-match → allowed and cached", async () => {
    const r = resolver({ status: "active", userId: SUB });
    const d = await validateClerkSession({ sub: SUB, sessionId: SID, resolve: r, now: 1000 });
    expect(d).toEqual({ ok: true, reason: "active" });
  });

  it("★ NO HANDLE (no header) → 401 fail-closed, resolver never consulted", async () => {
    const r = resolver({ status: "active", userId: SUB });
    const d = await validateClerkSession({ sub: SUB, sessionId: undefined, resolve: r, now: 1000 });
    expect(d).toEqual({ ok: false, reason: "no-handle" });
    expect(r.calls).toBe(0);
  });

  it("★ REVOKED → 401 (the consent-kill)", async () => {
    const r = resolver({ status: "revoked" });
    const d = await validateClerkSession({ sub: SUB, sessionId: SID, resolve: r, now: 1000 });
    expect(d).toEqual({ ok: false, reason: "revoked" });
  });

  it("NOT-FOUND → 401", async () => {
    const r = resolver({ status: "not_found" });
    const d = await validateClerkSession({ sub: SUB, sessionId: SID, resolve: r, now: 1000 });
    expect(d).toEqual({ ok: false, reason: "not-found" });
  });

  it("★ ACTIVE but sub MISMATCH → 401, and NOT cached (the self-attack bound)", async () => {
    const r = resolver({ status: "active", userId: "user_ATTACKER_OWNS" });
    const d = await validateClerkSession({ sub: SUB, sessionId: SID, resolve: r, now: 1000 });
    expect(d).toEqual({ ok: false, reason: "sub-mismatch" });
    // Not cached: a second call must re-resolve, never serve the mismatch as a hit.
    const d2 = await validateClerkSession({ sub: SUB, sessionId: SID, resolve: r, now: 1001 });
    expect(d2).toEqual({ ok: false, reason: "sub-mismatch" });
    expect(r.calls).toBe(2);
  });

  it("★ UNREACHABLE → FAIL-OPEN degraded, with a loud ERROR + metric", async () => {
    const errors: string[] = [];
    const metrics: string[] = [];
    const r = resolver({ status: "unreachable" });
    const d = await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: r,
      now: 1000,
      logger: { error: (m) => errors.push(m) },
      metric: (m) => metrics.push(m),
    });
    expect(d).toEqual({ ok: true, reason: "fail-open-unreachable", degraded: true });
    expect(errors.join(" ")).toMatch(/UNREACHABLE|FAIL-OPEN/);
    expect(metrics).toContain("clerk_session_validation_fail_open");
  });

  it("a resolver that THROWS is treated as unreachable → fail-open (never crashes the turn)", async () => {
    const r = (async () => {
      throw new Error("network down");
    }) as ClerkSessionResolver;
    const d = await validateClerkSession({ sub: SUB, sessionId: SID, resolve: r, now: 1000 });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.reason).toBe("fail-open-unreachable");
    }
  });
});

describe("positive cache (config-knob TTL)", () => {
  it("★ a second turn within TTL is served from cache — no second Clerk call", async () => {
    const r = resolver({ status: "active", userId: SUB });
    await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: r,
      cacheTtlMs: 30_000,
      now: 1000,
    });
    const d2 = await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: r,
      cacheTtlMs: 30_000,
      now: 5000,
    });
    expect(d2).toEqual({ ok: true, reason: "active-cached" });
    expect(r.calls).toBe(1); // resolved once, cached thereafter
  });

  it("★ after the TTL expires it RE-RESOLVES (revocation bites on the next turn past the window)", async () => {
    const r = resolver({ status: "active", userId: SUB });
    await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: r,
      cacheTtlMs: 1000,
      now: 1000,
    });
    // A revocation happens; the resolver now reports revoked.
    const revoked = resolver({ status: "revoked" });
    const d = await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: revoked,
      cacheTtlMs: 1000,
      now: 2500,
    });
    expect(d).toEqual({ ok: false, reason: "revoked" });
  });

  it("★ a cached ACTIVE session STILL enforces sub-match (cannot serve user A's cache to user B)", async () => {
    const r = resolver({ status: "active", userId: SUB });
    await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: r,
      cacheTtlMs: 30_000,
      now: 1000,
    });
    const d = await validateClerkSession({
      sub: "user_OTHER",
      sessionId: SID,
      resolve: r,
      cacheTtlMs: 30_000,
      now: 2000,
    });
    expect(d).toEqual({ ok: false, reason: "sub-mismatch" });
  });

  it("★ evictClerkSessionCache closes the positive window immediately (unbind → next turn re-resolves)", async () => {
    const r = resolver({ status: "active", userId: SUB });
    await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: r,
      cacheTtlMs: 30_000,
      now: 1000,
    });
    evictClerkSessionCache(SID); // signout route calls this
    const revoked = resolver({ status: "revoked" });
    const d = await validateClerkSession({
      sub: SUB,
      sessionId: SID,
      resolve: revoked,
      cacheTtlMs: 30_000,
      now: 1500,
    });
    expect(d).toEqual({ ok: false, reason: "revoked" }); // re-resolved, not served stale
  });
});

describe("resolveSessionCacheTtlMs — the config knob", () => {
  it("prefers config, falls back to env, then the 30s default", () => {
    expect(resolveSessionCacheTtlMs({ sessionCacheTtlMs: 5000 }, {})).toBe(5000);
    expect(
      resolveSessionCacheTtlMs(undefined, { OPENCLAW_CLERK_SESSION_CACHE_TTL_MS: "7000" }),
    ).toBe(7000);
    expect(resolveSessionCacheTtlMs(undefined, {})).toBe(30_000);
  });

  it("rejects garbage/negative and uses the default", () => {
    expect(resolveSessionCacheTtlMs(undefined, { OPENCLAW_CLERK_SESSION_CACHE_TTL_MS: "-1" })).toBe(
      30_000,
    );
    expect(
      resolveSessionCacheTtlMs(undefined, { OPENCLAW_CLERK_SESSION_CACHE_TTL_MS: "nope" }),
    ).toBe(30_000);
  });

  it("allows 0 (no caching — every turn re-resolves)", () => {
    expect(resolveSessionCacheTtlMs({ sessionCacheTtlMs: 0 }, {})).toBe(0);
  });
});
