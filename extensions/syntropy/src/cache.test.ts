/**
 * Unit tests for the bounded TTL cache used by the syntropy plugin
 * to memoize per-session ResolvedUser between `before_agent_start`
 * and the synchronous tool factory.
 *
 * Requirements (from PR #9 review follow-up):
 * - Set + get round-trip
 * - Entry expires after `ttlMs`
 * - LRU eviction when `maxSize` exceeded (oldest-accessed evicted first)
 * - Manual delete
 * - Bounded — no unbounded growth even under churn
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("set + get returns the stored value", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  test("get returns undefined for missing keys", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    expect(cache.get("missing")).toBeUndefined();
  });

  test("entry expires after ttlMs", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    vi.advanceTimersByTime(999);
    expect(cache.get("a")).toBe(1); // not yet expired
    vi.advanceTimersByTime(2);
    expect(cache.get("a")).toBeUndefined(); // expired
  });

  test("set on existing key resets the TTL", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    cache.set("a", 1);
    vi.advanceTimersByTime(900);
    cache.set("a", 2); // refresh
    vi.advanceTimersByTime(500);
    expect(cache.get("a")).toBe(2); // still alive: 500ms after refresh
  });

  test("eviction when maxSize exceeded — oldest-inserted goes first", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 60_000, maxSize: 3 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // triggers eviction
    expect(cache.get("a")).toBeUndefined(); // evicted
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  test("delete removes the entry immediately", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    cache.set("a", 1);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
  });

  test("delete is a no-op for missing keys", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    expect(() => cache.delete("missing")).not.toThrow();
  });

  test("cache stays bounded under churn — never exceeds maxSize", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 60_000, maxSize: 5 });
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, i);
    expect(cache.size()).toBe(5);
  });

  test("expired entries are not counted in size after access", () => {
    const cache = new TtlCache<string, number>({ ttlMs: 1000, maxSize: 10 });
    cache.set("a", 1);
    cache.set("b", 2);
    vi.advanceTimersByTime(1001);
    // Access both to trigger lazy expiry
    cache.get("a");
    cache.get("b");
    expect(cache.size()).toBe(0);
  });

  test("construction with non-positive maxSize throws", () => {
    expect(() => new TtlCache({ ttlMs: 1000, maxSize: 0 })).toThrow();
    expect(() => new TtlCache({ ttlMs: 1000, maxSize: -1 })).toThrow();
  });

  test("construction with non-positive ttlMs throws", () => {
    expect(() => new TtlCache({ ttlMs: 0, maxSize: 10 })).toThrow();
    expect(() => new TtlCache({ ttlMs: -1, maxSize: 10 })).toThrow();
  });
});
