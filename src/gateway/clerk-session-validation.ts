/**
 * Server-side Clerk session validation (G-lane [G2b], A&D §7.4b-A — the ruled
 * revocation control that REPLACES the withdrawn deny-lists).
 *
 * Why this exists, stated once so it is never rebuilt wrong a fourth time: the
 * gateway's entire notion of "authorized" used to be "presented a crypto-valid
 * ~60s JWT" — it never asked Clerk anything. Two local deny-lists failed the
 * §2.5 requirement ("signing out ENDS gateway access") for the same root reason:
 * a `sid` list was inert (template tokens carry no sid) and a `jti` list was
 * re-mintable (a session holder mints a fresh token). The authority for "is this
 * session still alive" lives at CLERK, so the gateway must ASK Clerk.
 *
 * MODEL: on a clerk-jwt turn, take the session id (Option B — a header, treated
 * as a LOOKUP KEY, NEVER an assertion), resolve it against Clerk, and:
 *   • ACTIVE  + sub-match   → allow (cache the positive ≤ TTL)
 *   • ACTIVE  + sub MISMATCH → 401 (the header named someone else's session)
 *   • REVOKED / NOT-FOUND   → 401 (this is the consent-kill; survives re-mint)
 *   • UNREACHABLE (Clerk 5xx/timeout) → FAIL-OPEN + loud ERROR + metric
 *   • NO HANDLE (no header) → 401 (fail-closed; a client must not opt out)
 *
 * The resolver is INJECTED so every unit test runs deterministically with no
 * network, and the live QA harness injects the REAL Clerk-backed resolver
 * (identical code path, real wire) — the design must be provable without faking
 * the boundary it defends.
 */

/** The authoritative status of a session, as Clerk reports it. */
export type ResolvedSession =
  | { status: "active"; userId: string }
  /** Clerk says the session is revoked/expired/ended — all collapse here. */
  | { status: "revoked" }
  /** Clerk has no such session id. */
  | { status: "not_found" }
  /** Clerk could not be reached (timeout / 5xx). Distinct from "revoked". */
  | { status: "unreachable" };

/** Resolve a session id against the source of truth (Clerk). Injectable. */
export type ClerkSessionResolver = (sessionId: string) => Promise<ResolvedSession>;

export type SessionValidationDecision =
  | { ok: true; reason: "active" | "active-cached" }
  | { ok: true; reason: "fail-open-unreachable"; degraded: true }
  | { ok: false; reason: "no-handle" | "revoked" | "not-found" | "sub-mismatch" };

const DEFAULT_CACHE_TTL_MS = 30_000; // config knob; principal wants it tunable
const MAX_CACHE_ENTRIES = 10_000;

type CacheEntry = { userId: string; expiresAt: number };

/**
 * Positive-only session cache: avoids a Clerk round-trip per turn for a session
 * we just saw ACTIVE. Bounded window (the TTL) is the residual, stated not
 * hidden. NEVER caches negatives — a revocation must bite on the next turn.
 * Lives on a `Symbol.for` global so the writer (chat path) and the evictor
 * (signout route, loaded as an extension via jiti) share ONE store per process.
 */
const CACHE_KEY = Symbol.for("openclaw.clerkSessionCache");

function cache(): Map<string, CacheEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, CacheEntry>>;
  let map = g[CACHE_KEY];
  if (!map) {
    map = new Map();
    g[CACHE_KEY] = map;
  }
  return map;
}

function sweep(map: Map<string, CacheEntry>, now: number): void {
  for (const [id, entry] of map) {
    if (entry.expiresAt <= now) {
      map.delete(id);
    }
  }
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

export function resolveSessionCacheTtlMs(
  config?: { sessionCacheTtlMs?: number },
  env = process.env,
): number {
  const raw = config?.sessionCacheTtlMs ?? Number(env.OPENCLAW_CLERK_SESSION_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

/** Evict a session's cached positive — called on unbind so consent-kill is immediate. */
export function evictClerkSessionCache(sessionId: string | undefined): void {
  const id = sessionId?.trim();
  if (id) {
    cache().delete(id);
  }
}

/** Test hook. */
export function clearClerkSessionCache(): void {
  cache().clear();
}

export type ValidateClerkSessionParams = {
  /** The verified token `sub` — the identity the session MUST belong to. */
  sub: string;
  /** The session id from the header. A LOOKUP KEY, never trusted as identity. */
  sessionId: string | undefined;
  /** Resolve against Clerk (injected). */
  resolve: ClerkSessionResolver;
  /** Positive-cache TTL (ms). Config knob. */
  cacheTtlMs?: number;
  now: number;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /** Emit a named metric (e.g. the fail-open alarm). Injectable. */
  metric?: (name: string) => void;
};

/**
 * The full §7.4b-A decision. Pure but for the injected resolver/clock; every
 * branch is unit-reachable. The header is a lookup key — NOTHING about identity
 * or entitlement is inferred from it; only the RESOLUTION is trusted, and even
 * then only after the sub-match.
 */
export async function validateClerkSession(
  params: ValidateClerkSessionParams,
): Promise<SessionValidationDecision> {
  const ttl = params.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const sessionId = params.sessionId?.trim();

  // NO HANDLE → fail-closed. A client must never opt out of revocation by
  // omitting the header (the "silently inert, a third time" guard).
  if (!sessionId) {
    params.logger?.warn?.("clerk-session: NO session-id handle → 401 (fail-closed)");
    return { ok: false, reason: "no-handle" };
  }

  const store = cache();
  sweep(store, params.now);

  // Positive-cache hit — but sub-match STILL applies: a cached active session
  // for user A must not authorize user B who named A's session id.
  const cached = store.get(sessionId);
  if (cached && cached.expiresAt > params.now) {
    if (cached.userId !== params.sub) {
      params.logger?.warn?.("clerk-session: cached session belongs to a DIFFERENT sub → 401");
      return { ok: false, reason: "sub-mismatch" };
    }
    return { ok: true, reason: "active-cached" };
  }

  let resolved: ResolvedSession;
  try {
    resolved = await params.resolve(sessionId);
  } catch {
    resolved = { status: "unreachable" };
  }

  switch (resolved.status) {
    case "active": {
      // THE residual the principal will not take on faith: the resolved session
      // must belong to the token's sub, or a client could name someone else's
      // live session id with its own token. Never cached on mismatch.
      if (resolved.userId !== params.sub) {
        params.logger?.warn?.(
          "clerk-session: resolved session sub-MISMATCH → 401 (self-attack bound)",
        );
        return { ok: false, reason: "sub-mismatch" };
      }
      store.set(sessionId, { userId: resolved.userId, expiresAt: params.now + ttl });
      return { ok: true, reason: "active" };
    }
    case "revoked":
      params.logger?.info?.("clerk-session: REVOKED → 401 (consent-kill, survives re-mint)");
      return { ok: false, reason: "revoked" };
    case "not_found":
      params.logger?.info?.("clerk-session: NOT-FOUND → 401");
      return { ok: false, reason: "not-found" };
    case "unreachable":
      // Ratified product risk: a Clerk outage must not down the whole chat plane
      // to close a ≤60s window for a signed-out minority. LOUD + metered so it is
      // never silent.
      params.logger?.error?.("clerk-session: Clerk UNREACHABLE → FAIL-OPEN (degraded, allowed)");
      params.metric?.("clerk_session_validation_fail_open");
      return { ok: true, reason: "fail-open-unreachable", degraded: true };
  }
}
