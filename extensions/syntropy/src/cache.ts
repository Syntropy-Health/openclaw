/**
 * Bounded TTL cache for per-session user resolution.
 *
 * Replaces the unbounded `Map<string, ResolvedUser>` that was caching
 * results between `before_agent_start` and the synchronous tool factory.
 * That map had no TTL or size bound — long-running gateways accumulated
 * entries indefinitely (PR #9 review follow-up, Item 2).
 *
 * Eviction policy: oldest-inserted-first when `maxSize` is exceeded.
 * Stale entries are pruned lazily on `get` rather than via a background
 * timer — keeps the cache zero-async and avoids unref'd timer overhead.
 */

export interface TtlCacheOptions {
  /** Time-to-live for each entry, in milliseconds. Must be > 0. */
  ttlMs: number;
  /** Maximum number of entries. Oldest-inserted is evicted on overflow. Must be > 0. */
  maxSize: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly entries = new Map<K, Entry<V>>();

  constructor(opts: TtlCacheOptions) {
    if (opts.ttlMs <= 0) throw new Error("TtlCache: ttlMs must be > 0");
    if (opts.maxSize <= 0) throw new Error("TtlCache: maxSize must be > 0");
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize;
  }

  /** Insert or refresh an entry. Resets TTL. Evicts oldest-inserted on overflow. */
  set(key: K, value: V): void {
    // Re-set rebuilds insertion order so refresh moves the entry to "newest".
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxSize) {
      // Map preserves insertion order — first key is oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Get a live entry; returns undefined for missing or expired. Expired entries are pruned. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Remove an entry. No-op if absent. */
  delete(key: K): void {
    this.entries.delete(key);
  }

  /** Number of currently-stored entries. May include lazily-expired entries until accessed. */
  size(): number {
    return this.entries.size;
  }
}
