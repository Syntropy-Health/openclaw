/**
 * SEALED challenge suite — SYN-206 Task 2: `resolveProfileContext`.
 *
 * Double-blind: written from the contract
 * (extensions/syntropy/docs/SYN-206-task2-profileContext.contract.md, Part A)
 * with NO sight of the implementation. The implementer never sees this file.
 *
 * Contract under challenge (Part A):
 *   resolveProfileContext({ cache, cacheKey, fetchProfile }): Promise<string|null>
 *   1. Cache hit  → return cached string, MUST NOT call fetchProfile.
 *   2. Cache miss → await fetchProfile():
 *        - !ok            → return null (inject nothing), do not cache.
 *        - ok + block     → cache.set(cacheKey, block), return block.
 *        - ok + null block→ return null, do NOT cache (re-check next turn).
 *   3. Failure-safe → fetchProfile rejects/throws ⇒ resolve null, never throw.
 *
 * Categories (top-level describe = referee aggregation unit):
 *   functional/cache, functional/fetch, functional/resilience.
 *
 * The real TtlCache backs the cache here (behavior, not internals). A generous
 * ttl/maxSize keeps entries live for the duration of a test.
 */
import { describe, it, expect, vi } from "vitest";
import { TtlCache } from "../../../extensions/syntropy/src/cache.js";
import { resolveProfileContext } from "../../../extensions/syntropy/src/profile-context.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh, generous cache that won't expire or evict during a test. */
function freshCache(): TtlCache<string, string> {
  return new TtlCache<string, string>({ ttlMs: 60_000, maxSize: 1_000 });
}

/** A valid HealthProfileContract with one safety-critical field populated. */
function validProfile() {
  return {
    allergies: ["peanuts"],
    conditions: [],
    health_goals: [],
    supplement_stack: [],
    dietary_preferences: {},
    metrics_data: {},
  };
}

/** A structurally-valid but fully-empty profile (formatProfileBlock → null). */
function emptyProfile() {
  return {
    allergies: [],
    conditions: [],
    health_goals: [],
    supplement_stack: [],
    dietary_preferences: {},
    metrics_data: {},
  };
}

const KEY = "whatsapp:+15551234567";

// ---------------------------------------------------------------------------
// functional/cache — cache hit vs miss
// ---------------------------------------------------------------------------

describe("functional/cache", () => {
  it("returns the cached string verbatim on a hit and never calls fetchProfile", async () => {
    const cache = freshCache();
    const cached = "[SYNTROPY_PROFILE]\nallergies: shellfish\n[/SYNTROPY_PROFILE]";
    cache.set(KEY, cached);
    const fetchProfile = vi.fn();

    const result = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(result).toBe(cached);
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it("on a miss with a valid profile, fetches exactly once and returns the block", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn().mockResolvedValue({ ok: true, data: validProfile() });

    const result = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(result).not.toBeNull();
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it("stores the block so a second call is a hit and does not fetch again", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn().mockResolvedValue({ ok: true, data: validProfile() });

    const first = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });
    const second = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(second).toBe(first);
    expect(fetchProfile).toHaveBeenCalledTimes(1);
  });

  it("scopes by cacheKey: a hit on one key does not serve another key's call", async () => {
    const cache = freshCache();
    // Pre-seed key A with a sentinel block that is NOT derivable from any
    // profile fixture below — so a cross-key leak would surface as this exact
    // string, which formatProfileBlock(validProfile()) provably never produces.
    const aBlock = "[SYNTROPY_PROFILE]\nallergies: PRESEEDED-A-ONLY\n[/SYNTROPY_PROFILE]";
    cache.set("whatsapp:+1AAA", aBlock);
    const fetchProfile = vi.fn().mockResolvedValue({ ok: true, data: validProfile() });

    const other = await resolveProfileContext({
      cache,
      cacheKey: "whatsapp:+1BBB",
      fetchProfile,
    });

    // Different key → miss → must fetch (cannot return key A's cached entry).
    expect(fetchProfile).toHaveBeenCalledTimes(1);
    // No cross-key leak: the returned block is not key A's entry, and key A's
    // cache entry is left untouched by the BBB call.
    expect(other).not.toBe(aBlock);
    expect(cache.get("whatsapp:+1AAA")).toBe(aBlock);
    // Structural identity-scoping invariant: BBB's freshly-resolved block is
    // exactly what the cache now holds under BBB's own key — asserted without
    // hard-coding the formatter's output string.
    expect(other).toBe(cache.get("whatsapp:+1BBB"));
  });
});

// ---------------------------------------------------------------------------
// functional/fetch — ok / !ok / null-block handling
// ---------------------------------------------------------------------------

describe("functional/fetch", () => {
  it("returns the formatted block for an ok result with a valid profile", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn().mockResolvedValue({ ok: true, data: validProfile() });

    const result = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
    expect(result as string).toMatch(/^\[SYNTROPY_PROFILE\]/);
    expect(result as string).toContain("allergies: peanuts");
  });

  it("returns null and caches nothing when the result is not ok (re-fetches next turn)", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn().mockResolvedValue({ ok: false, error: "boom", data: null });

    const first = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });
    const second = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });

  it("returns null and caches nothing when an ok+empty profile formats to null", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn().mockResolvedValue({ ok: true, data: emptyProfile() });

    const first = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });
    const second = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });

  it("returns null for an ok result whose data is a failure envelope ({ error })", async () => {
    const cache = freshCache();
    const fetchProfile = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { error: "Health profile not found" } });

    const result = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// functional/resilience — never throws when fetchProfile rejects
// ---------------------------------------------------------------------------

describe("functional/resilience", () => {
  it("resolves to null (does not reject) when fetchProfile throws synchronously", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn(() => {
      throw new Error("sync boom");
    });

    await expect(resolveProfileContext({ cache, cacheKey: KEY, fetchProfile })).resolves.toBeNull();
  });

  it("resolves to null (does not reject) when fetchProfile returns a rejected promise", async () => {
    const cache = freshCache();
    const fetchProfile = vi.fn().mockRejectedValue(new Error("async boom"));

    await expect(resolveProfileContext({ cache, cacheKey: KEY, fetchProfile })).resolves.toBeNull();
  });

  it("does not cache anything after a rejection (a later ok call still fetches)", async () => {
    const cache = freshCache();
    const fetchProfile = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ ok: true, data: validProfile() });

    const first = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });
    const second = await resolveProfileContext({ cache, cacheKey: KEY, fetchProfile });

    expect(first).toBeNull();
    expect(second).not.toBeNull();
    expect(fetchProfile).toHaveBeenCalledTimes(2);
  });
});
