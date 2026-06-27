/**
 * SEALED challenge suite — Phase C (τ-metering), contract §9.
 *
 * Category: functional/tau-meter
 *
 * These tests challenge the per-`user_scope` τ budget meter against the §9
 * contract ONLY (createTauMeter public interface). They do NOT depend on any
 * server-http wiring. The meter has no `now`-injection seam, so window-slide
 * behavior is driven with vitest fake timers (the meter reads Date.now()).
 *
 * Contract clauses exercised here:
 *   (a) keyed on user_scope; (c) no-op below threshold; (d) unscoped never
 *   metered (fail-open); (e) distinct scopes independent; (f) sliding-window
 *   reset; plus the 429/Retry-After signal source (retryAfterMs > 0 on
 *   exhaustion).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTauMeter, type TauMeter } from "./tau-meter.js";

describe("functional/tau-meter — createTauMeter (contract §9)", () => {
  let meter: TauMeter | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor to a fixed instant so window math is deterministic.
    vi.setSystemTime(new Date("2026-06-21T00:00:00.000Z"));
  });

  afterEach(() => {
    meter?.dispose();
    meter = undefined;
    vi.useRealTimers();
  });

  it("under budget: check() is allowed and does NOT consume; record() decrements remaining", () => {
    meter = createTauMeter({ maxCostPerWindow: 3, windowMs: 60_000 });

    // check() must not consume budget — repeated checks stay at full remaining.
    const c1 = meter.check("user_a");
    expect(c1.allowed).toBe(true);
    expect(c1.remaining).toBe(3);
    expect(c1.retryAfterMs).toBe(0);

    const c2 = meter.check("user_a");
    expect(c2.allowed).toBe(true);
    expect(c2.remaining).toBe(3);

    // record() consumes; remaining reflects the spend on the NEXT check.
    meter.record("user_a"); // default cost 1
    expect(meter.check("user_a").remaining).toBe(2);

    meter.record("user_a", 1);
    expect(meter.check("user_a").remaining).toBe(1);
  });

  it("at/over budget: throttled with allowed=false, remaining 0, retryAfterMs Retry-After-able", () => {
    meter = createTauMeter({ maxCostPerWindow: 2, windowMs: 60_000, retryAfterMs: 30_000 });

    meter.record("user_a"); // 1
    expect(meter.check("user_a").allowed).toBe(true);
    expect(meter.check("user_a").remaining).toBe(1);

    meter.record("user_a"); // 2 -> exhausts budget (>= maxCost blocks)
    const blocked = meter.check("user_a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    // retryAfterMs must be strictly positive so the HTTP layer can emit a
    // non-zero Retry-After header (sendRateLimited only sets it when > 0).
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    // And it must be Retry-After-able: ceil(ms/1000) seconds is a positive int.
    expect(Math.ceil(blocked.retryAfterMs / 1000)).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it("maxCostPerWindow respected with default per-turn cost of 1", () => {
    meter = createTauMeter({ maxCostPerWindow: 5, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      expect(meter.check("u").allowed).toBe(true);
      meter.record("u");
    }
    // 6th turn must be throttled.
    const sixth = meter.check("u");
    expect(sixth.allowed).toBe(false);
    expect(sixth.remaining).toBe(0);
    expect(sixth.retryAfterMs).toBeGreaterThan(0);
  });

  it("maxCostPerWindow respected with explicit token costs", () => {
    meter = createTauMeter({ maxCostPerWindow: 100, windowMs: 60_000 });

    meter.record("u", 40);
    expect(meter.check("u").remaining).toBe(60);
    expect(meter.check("u").allowed).toBe(true);

    meter.record("u", 60); // total 100 >= max -> exhausted
    const after = meter.check("u");
    expect(after.allowed).toBe(false);
    expect(after.remaining).toBe(0);
    expect(after.retryAfterMs).toBeGreaterThan(0);
  });

  describe("unscoped requests are NEVER metered (contract §9d, fail-open)", () => {
    it.each([
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace", "   "],
      ["tab/newline", "\t\n"],
    ])("scope=%s: always allowed, record() is a no-op (size stays 0)", (_label, scope) => {
      meter = createTauMeter({ maxCostPerWindow: 1, windowMs: 60_000 });

      // Even far beyond budget, an unscoped request is never throttled.
      for (let i = 0; i < 10; i++) {
        const r = meter.check(scope);
        expect(r.allowed).toBe(true);
        expect(r.retryAfterMs).toBe(0);
        meter.record(scope);
      }
      // record() on an empty scope must not allocate an entry.
      expect(meter.size()).toBe(0);
    });
  });

  it("distinct user_scopes are independent budgets (contract §9e)", () => {
    meter = createTauMeter({ maxCostPerWindow: 1, windowMs: 60_000 });

    meter.record("user_a"); // exhaust A
    expect(meter.check("user_a").allowed).toBe(false);

    // B is untouched and still admitted.
    const b = meter.check("user_b");
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBe(1);
    expect(b.retryAfterMs).toBe(0);
  });

  it("all of a user's consumers share ONE budget (keyed on user_scope, §9a)", () => {
    // Two different client connections resolving to the SAME user_scope must
    // NOT each get a fresh budget — that is the whole point of scope-keying.
    meter = createTauMeter({ maxCostPerWindow: 2, windowMs: 60_000 });
    const scope = "user_shared";

    meter.record(scope); // consumer 1, turn 1
    meter.record(scope); // consumer 2, turn 1 -> total 2 exhausts shared budget
    expect(meter.check(scope).allowed).toBe(false);
  });

  it("budget resets after the sliding window elapses (contract §9f)", () => {
    meter = createTauMeter({ maxCostPerWindow: 1, windowMs: 60_000, retryAfterMs: 60_000 });

    meter.record("user_a");
    expect(meter.check("user_a").allowed).toBe(false);

    // Just before the block expires: still throttled.
    vi.advanceTimersByTime(59_999);
    expect(meter.check("user_a").allowed).toBe(false);

    // After retryAfter elapses the scope is re-admitted with full budget.
    vi.advanceTimersByTime(2);
    const readmit = meter.check("user_a");
    expect(readmit.allowed).toBe(true);
    expect(readmit.remaining).toBe(1);
    expect(readmit.retryAfterMs).toBe(0);
  });

  it("sliding window expires individual events (re-admit without explicit block)", () => {
    // maxCost 2, window 10s. Two spaced records inside the window throttle;
    // once the first event slides out of the window, budget frees up.
    meter = createTauMeter({ maxCostPerWindow: 2, windowMs: 10_000, retryAfterMs: 1 });

    meter.record("u"); // t=0
    vi.advanceTimersByTime(5_000);
    meter.record("u"); // t=5s -> total 2, exhausted, blockedUntil = t+1ms

    // Let the short block clear but keep the t=0 event inside a fresh count.
    vi.advanceTimersByTime(2); // block (retryAfter=1ms) cleared
    // After block clears the entry is reset, so the scope is admitted again.
    expect(meter.check("u").allowed).toBe(true);
  });

  it("prune() drops expired entries and frees memory", () => {
    meter = createTauMeter({ maxCostPerWindow: 10, windowMs: 10_000 });

    meter.record("user_a");
    meter.record("user_b");
    expect(meter.size()).toBe(2);

    // Advance well past the window so all events are expired.
    vi.advanceTimersByTime(20_000);
    meter.prune();
    expect(meter.size()).toBe(0);
  });

  it("prune() keeps still-blocked scopes", () => {
    meter = createTauMeter({ maxCostPerWindow: 1, windowMs: 10_000, retryAfterMs: 60_000 });
    meter.record("blocked_user"); // exhausts -> blockedUntil = now + 60s
    expect(meter.size()).toBe(1);

    // Past the window but still inside the block — must survive pruning.
    vi.advanceTimersByTime(11_000);
    meter.prune();
    expect(meter.size()).toBe(1);
    expect(meter.check("blocked_user").allowed).toBe(false);
  });

  it("dispose() is safe and idempotent", () => {
    const m = createTauMeter({ maxCostPerWindow: 1, windowMs: 1_000 });
    m.record("u");
    expect(() => m.dispose()).not.toThrow();
    // A second dispose must not throw.
    expect(() => m.dispose()).not.toThrow();
    // After dispose the meter is cleared.
    expect(m.size()).toBe(0);
  });

  it("record() with zero/negative cost is a no-op (does not consume budget)", () => {
    meter = createTauMeter({ maxCostPerWindow: 2, windowMs: 60_000 });
    meter.record("u", 0);
    meter.record("u", -5);
    // Budget untouched.
    expect(meter.check("u").remaining).toBe(2);
    expect(meter.size()).toBe(0);
  });
});
