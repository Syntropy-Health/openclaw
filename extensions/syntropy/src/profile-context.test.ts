import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.js";
import type { SyntropyToolResult } from "./client.js";
import { resolveProfileContext } from "./profile-context.js";

const PROFILE = { allergies: ["peanuts"] };
const ok = (data: unknown): SyntropyToolResult => ({ data, ok: true });
const notOk = (): SyntropyToolResult => ({ data: null, ok: false, error: "boom" });

function newCache() {
  return new TtlCache<string, string>({ ttlMs: 60_000, maxSize: 100 });
}

describe("resolveProfileContext", () => {
  it("cache hit returns cached without fetching", async () => {
    const cache = newCache();
    cache.set("c:p", "[SYNTROPY_PROFILE]\nallergies: peanuts\n[/SYNTROPY_PROFILE]");
    const fetchProfile = vi.fn<() => Promise<SyntropyToolResult>>();
    const block = await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    expect(block).toBe("[SYNTROPY_PROFILE]\nallergies: peanuts\n[/SYNTROPY_PROFILE]");
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("miss + ok → formats, caches, returns", async () => {
    const cache = newCache();
    const fetchProfile = vi.fn(async () => ok(PROFILE));
    const block = await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    expect(block).toContain("allergies: peanuts");
    expect(cache.get("c:p")).toBe(block);
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it("second call after a miss serves from cache (no second fetch)", async () => {
    const cache = newCache();
    const fetchProfile = vi.fn(async () => ok(PROFILE));
    const first = await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    const second = await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    expect(second).toBe(first);
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it("miss + not-ok → null, not cached", async () => {
    const cache = newCache();
    const block = await resolveProfileContext({
      cache,
      cacheKey: "c:p",
      fetchProfile: async () => notOk(),
    });
    expect(block).toBeNull();
    expect(cache.get("c:p")).toBeUndefined();
  });

  it("miss + ok but unusable block → null, not cached", async () => {
    const cache = newCache();
    const block = await resolveProfileContext({
      cache,
      cacheKey: "c:p",
      fetchProfile: async () => ok({ type: "paywall" }),
    });
    expect(block).toBeNull();
    expect(cache.get("c:p")).toBeUndefined();
  });

  it("not-ok then ok across two calls → second caches and returns", async () => {
    const cache = newCache();
    const r1 = await resolveProfileContext({
      cache,
      cacheKey: "c:p",
      fetchProfile: async () => notOk(),
    });
    expect(r1).toBeNull();
    expect(cache.get("c:p")).toBeUndefined();
    const r2 = await resolveProfileContext({
      cache,
      cacheKey: "c:p",
      fetchProfile: async () => ok(PROFILE),
    });
    expect(r2).toContain("allergies: peanuts");
    expect(cache.get("c:p")).toBe(r2);
  });

  it("expired entry triggers a refetch", async () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string, string>({ ttlMs: 1000, maxSize: 100 });
    const fetchProfile = vi.fn(async () => ok(PROFILE));
    await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    vi.advanceTimersByTime(2000);
    await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    expect(fetchProfile).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("identity scoping — different keys do not share", async () => {
    const cache = newCache();
    cache.set("a:1", "[SYNTROPY_PROFILE]\nallergies: x\n[/SYNTROPY_PROFILE]");
    const fetchProfile = vi.fn(async () => ok(PROFILE));
    const block = await resolveProfileContext({ cache, cacheKey: "b:2", fetchProfile });
    expect(block).toContain("allergies: peanuts");
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it("null-block miss is re-checked next turn (not cached)", async () => {
    const cache = newCache();
    const fetchProfile = vi.fn(async () => ok({ type: "paywall" }));
    await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    await resolveProfileContext({ cache, cacheKey: "c:p", fetchProfile });
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });

  it("hit does not re-set the cache (no TTL refresh)", async () => {
    const getSpy = vi.fn(() => "[SYNTROPY_PROFILE]\nallergies: x\n[/SYNTROPY_PROFILE]");
    const setSpy = vi.fn();
    const mockCache = {
      get: getSpy,
      set: setSpy,
      delete: vi.fn(),
      size: () => 0,
    } as unknown as TtlCache<string, string>;
    const fetchProfile = vi.fn<() => Promise<SyntropyToolResult>>();
    const block = await resolveProfileContext({ cache: mockCache, cacheKey: "c:p", fetchProfile });
    expect(block).toContain("allergies: x");
    expect(setSpy).not.toHaveBeenCalled();
    expect(fetchProfile).not.toHaveBeenCalled();
    expect(getSpy).toHaveBeenCalledWith("c:p");
  });

  it("non-string get is treated as a miss → fetch", async () => {
    const getSpy = vi.fn(() => undefined);
    const setSpy = vi.fn();
    const mockCache = {
      get: getSpy,
      set: setSpy,
      delete: vi.fn(),
      size: () => 0,
    } as unknown as TtlCache<string, string>;
    const fetchProfile = vi.fn(async () => ok(PROFILE));
    const block = await resolveProfileContext({ cache: mockCache, cacheKey: "c:p", fetchProfile });
    expect(block).toContain("allergies: peanuts");
    expect(fetchProfile).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith("c:p", block);
  });

  it("fetch throws → null, never throws", async () => {
    const cache = newCache();
    const block = await resolveProfileContext({
      cache,
      cacheKey: "c:p",
      fetchProfile: async () => {
        throw new Error("network");
      },
    });
    expect(block).toBeNull();
  });
});
