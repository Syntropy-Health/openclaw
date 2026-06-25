/**
 * Per-`user_scope` τ (token) budget / rate meter for the HTTP chat path.
 *
 * This is the §9 contract limiter: a request quota keyed on the server-derived
 * `user_scope` (the verified Clerk `sub`), NOT on IP. Because all of a user's
 * consumers (mobile + WhatsApp + SJ) resolve to the SAME `user_scope`, they
 * share ONE budget — a user cannot multiply their allowance by adding clients.
 *
 * Design (mirrors auth-rate-limit.ts deliberately):
 *   - Pure in-memory sliding window — no external dependency, single-process.
 *     The Map is periodically pruned to bound growth.
 *   - A "turn" is one chat request admitted to the agent; a turn's recorded
 *     cost is `1` by default (turn count) or the token usage when supplied, so
 *     the same window can throttle on either request rate or τ spend.
 *   - **No-op below threshold:** `check()` on an unmetered/under-budget scope
 *     returns `{ allowed: true }` and never mutates the happy path. The meter is
 *     ONLY consulted for requests that carry a `user_scope` (Clerk-authed); a
 *     legacy request has no scope and is never metered here.
 *   - **Fail-open on missing scope:** an empty/undefined scope is allowed (it is
 *     unmetered, not blocked) — the auth layer, not the meter, fails closed.
 *
 * On exhaustion the caller returns 429 + `Retry-After` via the existing error
 * envelope (http-common.ts `sendRateLimited`).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TauMeterConfig {
  /**
   * Maximum cost admitted per window before throttling. With the default
   * per-turn cost of 1 this is "max turns per window". When callers record real
   * token usage it is "max τ per window".  @default 10_000 (generous)
   */
  maxCostPerWindow?: number;
  /** Sliding window duration in milliseconds.  @default 60_000 (1 min) */
  windowMs?: number;
  /**
   * How long a throttled scope stays blocked once the window budget is
   * exhausted; surfaced as `Retry-After`.  @default windowMs
   */
  retryAfterMs?: number;
}

export interface TauCheckResult {
  /** Whether the request is allowed to proceed (under budget). */
  allowed: boolean;
  /** Remaining budget in the current window (>= 0). */
  remaining: number;
  /** Milliseconds until the scope is admitted again (0 when allowed). */
  retryAfterMs: number;
}

export interface TauMeter {
  /**
   * Check whether `userScope` is under budget. A no-op (always allowed) when
   * `userScope` is empty/undefined. Does NOT consume budget — call `record`
   * after admitting a turn.
   */
  check(userScope: string | undefined): TauCheckResult;
  /**
   * Record consumed cost for `userScope` (default `1` = one turn). Pass the
   * turn's token usage to meter on τ spend. No-op for an empty scope.
   */
  record(userScope: string | undefined, cost?: number): void;
  /** Current number of tracked scopes (diagnostics). */
  size(): number;
  /** Remove expired entries and release memory. */
  prune(): void;
  /** Dispose the meter and cancel periodic cleanup timers. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_COST_PER_WINDOW = 10_000;
const DEFAULT_WINDOW_MS = 60_000;
const PRUNE_INTERVAL_MS = 60_000;

interface ScopeEntry {
  /** [timestampMs, cost] events inside the window. */
  events: Array<[number, number]>;
  /** If set, the scope is throttled until this epoch-ms instant. */
  blockedUntil?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createTauMeter(config?: TauMeterConfig): TauMeter {
  const maxCost = Math.max(1, config?.maxCostPerWindow ?? DEFAULT_MAX_COST_PER_WINDOW);
  const windowMs = Math.max(1, config?.windowMs ?? DEFAULT_WINDOW_MS);
  const retryAfterMs = Math.max(1, config?.retryAfterMs ?? windowMs);

  const entries = new Map<string, ScopeEntry>();

  const pruneTimer = setInterval(() => prune(), PRUNE_INTERVAL_MS);
  if (pruneTimer.unref) {
    pruneTimer.unref();
  }

  function normalizeScope(scope: string | undefined): string | undefined {
    const s = scope?.trim();
    return s || undefined;
  }

  function slideWindow(entry: ScopeEntry, now: number): void {
    const cutoff = now - windowMs;
    entry.events = entry.events.filter(([ts]) => ts > cutoff);
  }

  function windowCost(entry: ScopeEntry): number {
    let total = 0;
    for (const [, cost] of entry.events) {
      total += cost;
    }
    return total;
  }

  function check(rawScope: string | undefined): TauCheckResult {
    const scope = normalizeScope(rawScope);
    if (!scope) {
      // Unmetered (no user_scope) — never throttle the happy path.
      return { allowed: true, remaining: maxCost, retryAfterMs: 0 };
    }

    const now = Date.now();
    const entry = entries.get(scope);
    if (!entry) {
      return { allowed: true, remaining: maxCost, retryAfterMs: 0 };
    }

    if (entry.blockedUntil && now < entry.blockedUntil) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.blockedUntil - now };
    }
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      entry.blockedUntil = undefined;
      entry.events = [];
    }

    slideWindow(entry, now);
    const used = windowCost(entry);
    const remaining = Math.max(0, maxCost - used);
    return { allowed: remaining > 0, remaining, retryAfterMs: remaining > 0 ? 0 : retryAfterMs };
  }

  function record(rawScope: string | undefined, cost = 1): void {
    const scope = normalizeScope(rawScope);
    if (!scope) {
      return;
    }
    const amount = Math.max(0, cost);
    if (amount === 0) {
      return;
    }

    const now = Date.now();
    let entry = entries.get(scope);
    if (!entry) {
      entry = { events: [] };
      entries.set(scope, entry);
    }

    if (entry.blockedUntil && now < entry.blockedUntil) {
      return;
    }

    slideWindow(entry, now);
    entry.events.push([now, amount]);

    if (windowCost(entry) >= maxCost) {
      entry.blockedUntil = now + retryAfterMs;
    }
  }

  function prune(): void {
    const now = Date.now();
    for (const [scope, entry] of entries) {
      if (entry.blockedUntil && now < entry.blockedUntil) {
        continue;
      }
      slideWindow(entry, now);
      if (entry.events.length === 0) {
        entries.delete(scope);
      }
    }
  }

  function size(): number {
    return entries.size;
  }

  function dispose(): void {
    clearInterval(pruneTimer);
    entries.clear();
  }

  return { check, record, size, prune, dispose };
}
