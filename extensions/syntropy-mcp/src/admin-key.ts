/**
 * AdminKeyVerifyClient — consume + validate a scoped OPAQUE Unkey admin key
 * (`sa_…`) into an {@link AdminIdentity} (ADR-0001, devex PIN 1, `572b90520`).
 * Mirrors {@link TokenExchangeClient}'s verify→cache→invalidate discipline:
 * server-side verify (opaque, so instantly revocable), short positive cache,
 * single-flight, fail-closed at every arrow.
 *
 * Two factors — a valid key ALONE is NOT admin (the F1 lesson):
 *   1. Unkey `keys.verifyKey` says valid + not-revoked + not-expired.
 *   2. `owner_id` ∈ the committed `support_agent_subjects` allowlist.
 * Either fails → `null` (not admin), never cached. Identity comes from the KEY
 * (`owner_id`), never the turn.
 */

import crypto from "node:crypto";
import type { AdminIdentity } from "./gate-context.js";

const DEFAULT_CACHE_TTL_MS = 30_000; // WS4 parity — a revoked key must bite fast
const MAX_CACHE_ENTRIES = 2_000;

/** The subset of Unkey `keys.verifyKey` we depend on. Injected so tests never hit the network. */
export type UnkeyVerifyResult = {
  valid: boolean;
  ownerId?: string;
  meta?: Record<string, unknown> | null;
  /** Unkey status code, e.g. "VALID" | "NOT_FOUND" | "FORBIDDEN" | "KEY_DISABLED" | "EXPIRED". */
  code?: string;
};
export type UnkeyVerifyFn = (key: string) => Promise<UnkeyVerifyResult>;

export type AdminKeyClientOptions = {
  /** The committed `support_agent_subjects` (clerk_user_ids). Boot-loaded, like Clerk config. */
  allowlist: Iterable<string>;
  verify: UnkeyVerifyFn;
  cacheTtlMs?: number;
  now?: () => number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
};

type CacheEntry = { identity: AdminIdentity; expiresAt: number };

/** Only `sa_`-prefixed opaque keys are admin candidates. */
export function looksLikeAdminKey(key: string | undefined): boolean {
  return typeof key === "string" && key.startsWith("sa_") && key.length > 3;
}

export class AdminKeyVerifyClient {
  private readonly allowlist: Set<string>;
  private readonly verifyFn: UnkeyVerifyFn;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly logger: AdminKeyClientOptions["logger"];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<AdminIdentity | null>>();

  constructor(opts: AdminKeyClientOptions) {
    this.allowlist = new Set(opts.allowlist);
    this.verifyFn = opts.verify;
    this.ttl = opts.cacheTtlMs && opts.cacheTtlMs > 0 ? opts.cacheTtlMs : DEFAULT_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger;
  }

  /** Never key the cache/logs on the raw secret. */
  private keyHash(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  /**
   * Resolve a raw admin key to a verified {@link AdminIdentity}, or `null` if it is
   * not a usable admin credential (fail-closed: absent/non-`sa_`/invalid/revoked/
   * expired/verify-error, or `owner_id` not in the allowlist). Positive results are
   * cached ≤ TTL; negatives are NEVER cached.
   */
  async resolveAdmin(key: string | undefined): Promise<AdminIdentity | null> {
    if (!looksLikeAdminKey(key)) {
      return null;
    }
    const k = key as string;
    const hash = this.keyHash(k);

    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > this.now()) {
      return cached.identity;
    }

    const existing = this.inFlight.get(hash);
    if (existing) {
      return existing;
    }
    const flight = this.verifyAndAuthorize(k, hash).finally(() => this.inFlight.delete(hash));
    this.inFlight.set(hash, flight);
    return flight;
  }

  private async verifyAndAuthorize(key: string, hash: string): Promise<AdminIdentity | null> {
    let res: UnkeyVerifyResult;
    try {
      res = await this.verifyFn(key);
    } catch {
      this.logger?.warn?.("admin-key: verify UNREACHABLE → deny (fail-closed)");
      return null; // fail-closed: a verify error is NOT admin
    }

    if (!res.valid || !res.ownerId) {
      this.logger?.warn?.(`admin-key: key not valid (code=${res.code ?? "?"}) → deny`);
      return null;
    }

    // 2nd factor — never-self-approving. A valid key whose owner is not on the
    // committed allowlist is NOT admin.
    if (!this.allowlist.has(res.ownerId)) {
      this.logger?.warn?.(
        "admin-key: owner not in support_agent_subjects allowlist → deny (valid key alone ≠ admin)",
      );
      return null;
    }

    const identity: AdminIdentity = {
      adminSubject: res.ownerId,
      // Real boolean: `=== true` rejects a truthy string/number in meta (StrictBool source).
      phiClearance:
        (res.meta as { phi_clearance?: unknown } | null | undefined)?.phi_clearance === true,
    };
    this.cacheSet(hash, identity);
    this.logger?.info?.("admin-key: resolved ADMIN (valid + allowlisted) → is_admin");
    return identity;
  }

  private cacheSet(hash: string, identity: AdminIdentity): void {
    this.sweep();
    this.cache.set(hash, { identity, expiresAt: this.now() + this.ttl });
  }

  private sweep(): void {
    const now = this.now();
    for (const [h, e] of this.cache) {
      if (e.expiresAt <= now) {
        this.cache.delete(h);
      }
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  /** Drop a cached positive (e.g. on a downstream 401/403). */
  invalidate(key: string): void {
    this.cache.delete(this.keyHash(key));
  }
}
