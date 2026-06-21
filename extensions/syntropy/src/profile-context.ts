/**
 * Resolve the `[SYNTROPY_PROFILE]` context block for a paired user, with a
 * bounded TTL cache in front of the SJ `get_health_profile` fetch (SYN-206,
 * Task 2).
 *
 * Wires Task 1's `formatProfileBlock` into the `before_agent_start` hook:
 * a cache hit serves the formatted block without re-hitting SJ; a miss fetches,
 * formats, and caches only a usable (non-null) block so a transient empty /
 * failed profile is cheaply re-checked next turn while a real profile is served
 * from cache for the TTL.
 *
 * Failure-safe by construction: a not-ok envelope, an unusable profile, or a
 * thrown/rejected fetch all collapse to `null` so the caller injects nothing.
 * This function MUST NOT throw for any input — defence in depth alongside the
 * hook's own top-level try/catch.
 */

import type { TtlCache } from "./cache.js";
import type { SyntropyToolResult } from "./client.js";
import { formatProfileBlock } from "./profile.js";

/**
 * Resolve a user's profile context block, or `null` when nothing should be
 * injected.
 *
 * @param opts.cache         TtlCache keyed by the session cacheKey → formatted block.
 * @param opts.cacheKey      `${channel}:${peerId}` identity-scoping key.
 * @param opts.fetchProfile  Thunk that fetches the SJ `get_health_profile` result.
 * @param opts.inFlight      Optional single-flight map: coalesces concurrent
 *                           cold-key misses onto one fetch (dedup under burst).
 *                           Omit → unchanged behaviour (each miss fetches).
 * @param opts.negativeCache Optional short-TTL memo of "no usable profile": when a
 *                           fetch succeeds but yields no block, skip re-fetching
 *                           until this TTL expires. Omit → unchanged behaviour (an
 *                           empty profile re-fetches every turn). NOT set on
 *                           transient (`!ok`) failures.
 *
 * Behavior:
 * 1. Positive cache hit → return the cached block; `fetchProfile` is NOT called.
 * 1b. Negative cache hit (if provided) → return `null` without fetching.
 * 2. Single-flight (if provided): await a concurrent in-flight fetch for the same
 *    key instead of starting a second one.
 * 3. Cache miss → `await fetchProfile()`:
 *    - not ok (`ok === false`) → `null`, not cached (transient — re-check next turn).
 *    - ok → `formatProfileBlock(result.data)`:
 *      - non-empty string → positive-cache and return it.
 *      - `null` → negative-cache (if provided) and return `null`.
 * 4. `fetchProfile` rejects/throws → caught, returns `null`.
 */
export async function resolveProfileContext(opts: {
  cache: TtlCache<string, string>;
  cacheKey: string;
  fetchProfile: () => Promise<SyntropyToolResult>;
  inFlight?: Map<string, Promise<string | null>>;
  negativeCache?: TtlCache<string, true>;
}): Promise<string | null> {
  const { cache, cacheKey, fetchProfile, inFlight, negativeCache } = opts;

  // Whole body is failure-safe: any throw — a rejecting/throwing fetch, the
  // formatter, or even a hostile cache.get/set — collapses to null so the
  // caller injects nothing. resolveProfileContext MUST NOT throw for any input.
  try {
    // 1. Positive cache hit — serve without re-hitting SJ.
    const cached = cache.get(cacheKey);
    if (typeof cached === "string") return cached;

    // 1b. Negative cache hit — a recent fetch found no usable profile; don't
    //     hammer SJ on every turn until the short negative TTL expires.
    if (negativeCache?.get(cacheKey)) return null;

    // 2. Single-flight — coalesce concurrent cold-key misses onto one fetch.
    const existing = inFlight?.get(cacheKey);
    if (existing) return await existing;

    // 3. Cache miss — fetch, format, cache only usable blocks.
    const work = (async (): Promise<string | null> => {
      const result = await fetchProfile();
      if (!result.ok) return null; // transient — not negative-cached, re-fetch next turn.

      const block = formatProfileBlock(result.data);
      if (block === null) {
        negativeCache?.set(cacheKey, true); // empty/unusable — memo briefly.
        return null;
      }

      cache.set(cacheKey, block);
      return block;
    })();

    if (!inFlight) return await work;
    inFlight.set(cacheKey, work);
    try {
      return await work;
    } finally {
      inFlight.delete(cacheKey);
    }
  } catch {
    // 4. Failure-safe — never propagate.
    return null;
  }
}
