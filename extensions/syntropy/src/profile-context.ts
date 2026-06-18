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
 *
 * Behavior:
 * 1. Cache hit → return the cached block; `fetchProfile` is NOT called.
 * 2. Cache miss → `await fetchProfile()`:
 *    - not ok (`ok === false`) → `null` (inject nothing), not cached.
 *    - ok → `formatProfileBlock(result.data)`:
 *      - non-empty string → cache and return it.
 *      - `null` → `null`, NOT cached (re-check next turn).
 * 3. `fetchProfile` rejects/throws → caught, returns `null`.
 */
export async function resolveProfileContext(opts: {
  cache: TtlCache<string, string>;
  cacheKey: string;
  fetchProfile: () => Promise<SyntropyToolResult>;
}): Promise<string | null> {
  const { cache, cacheKey, fetchProfile } = opts;

  // Whole body is failure-safe: any throw — a rejecting/throwing fetch, the
  // formatter, or even a hostile cache.get/set — collapses to null so the
  // caller injects nothing. resolveProfileContext MUST NOT throw for any input.
  try {
    // 1. Cache hit — serve without re-hitting SJ.
    const cached = cache.get(cacheKey);
    if (typeof cached === "string") return cached;

    // 2. Cache miss — fetch, format, cache only usable blocks.
    const result = await fetchProfile();
    if (!result.ok) return null;

    const block = formatProfileBlock(result.data);
    if (block === null) return null; // unusable — do NOT cache, re-check next turn.

    cache.set(cacheKey, block);
    return block;
  } catch {
    // 3. Failure-safe — never propagate.
    return null;
  }
}
