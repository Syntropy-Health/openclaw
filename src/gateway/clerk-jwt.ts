// ---------------------------------------------------------------------------
// Clerk JWKS RS256 JWT verification — zero external dependencies.
//
// Verifies a Clerk-issued JWS using only `node:crypto` (no `jose`, no other
// npm dependency). Node's `createPublicKey({ key, format: "jwk" })` imports an
// RSA JWK and `crypto.verify("RSA-SHA256", ...)` checks the RS256 signature.
//
// Security posture:
//   - ALG-CONFUSION GUARD: header.alg MUST equal "RS256". "HS256", "none", and
//     anything else are rejected BEFORE any signature/key work, so an attacker
//     cannot downgrade to a symmetric/no-signature scheme.
//   - FAIL-CLOSED: any parse error, network error, missing key, bad signature,
//     or failed claim check returns `null`. verifyClerkJwt NEVER throws.
//
// JWKS handling: an in-memory, module-level, TTL'd cache keyed by jwksUrl. On
// an unknown `kid` we force exactly ONE cache-bypassing refresh before giving
// up — this tolerates Clerk key rotation without hammering the JWKS endpoint.
// ---------------------------------------------------------------------------

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
  [key: string]: unknown;
};

type JwtPayload = {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  [key: string]: unknown;
};

/** A JWKS document: `{ keys: [...] }`. */
type Jwks = { keys: JsonWebKey[] };

export type VerifyClerkJwtOptions = {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Unix seconds; defaults to now. */
  now?: number;
  /** Injectable JWKS fetcher; used INSTEAD of network fetch when provided. */
  fetchJwks?: (url: string) => Promise<Jwks>;
};

export type VerifiedClerkJwt = {
  sub: string;
  claims: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Module-level JWKS cache (keyed by jwksUrl)
// ---------------------------------------------------------------------------

const JWKS_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CacheEntry = { keys: JsonWebKey[]; fetchedAt: number };

const jwksCache = new Map<string, CacheEntry>();

/**
 * Resolve JWKS for a url. Fail-closed: any fetch error → empty key set.
 *
 * When `fetcher` (opts.fetchJwks) is provided it is the AUTHORITATIVE source and
 * is invoked on EVERY call, bypassing the module cache entirely — the caller has
 * taken over key sourcing, and the in-memory cache is only a network optimization
 * for the real-`fetch` path. (The cache key is the url alone, so caching an
 * injected-fetcher result would let one caller's keys shadow another's and would
 * silently skip the injected fetcher the contract says we must use.)
 *
 * On the network path the cache is honored unless `forceRefresh` is set or the
 * cached entry is past its TTL; a forced refresh re-fetches and refreshes it.
 */
async function resolveJwks(
  url: string,
  fetcher: ((url: string) => Promise<Jwks>) | undefined,
  forceRefresh: boolean,
): Promise<JsonWebKey[]> {
  // Injected fetcher is authoritative — never cache it, always invoke it.
  if (fetcher) {
    try {
      const jwks = await fetcher(url);
      return Array.isArray(jwks?.keys) ? jwks.keys : [];
    } catch {
      return [];
    }
  }

  if (!forceRefresh) {
    const cached = jwksCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
      return cached.keys;
    }
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return [];
    }
    const jwks = (await res.json()) as Jwks;
    const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
    jwksCache.set(url, { keys, fetchedAt: Date.now() });
    return keys;
  } catch {
    return [];
  }
}

/**
 * Find a signing JWK by EXACT `kid` match, honoring `use`/`kty` hints when
 * present. `kid` is always a non-empty string here (the caller requires it), so
 * there is no "first key" fallback — a kid with no exact match yields null.
 */
function findKeyByKid(keys: JsonWebKey[], kid: string): JsonWebKey | null {
  for (const key of keys) {
    const k = key as JsonWebKey & { kid?: string };
    if (k.kid !== kid) {
      continue;
    }
    if (k.use !== undefined && k.use !== "sig") {
      continue;
    }
    if (k.kty !== undefined && k.kty !== "RSA") {
      continue;
    }
    return key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

function decodeJsonSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as T;
}

// ---------------------------------------------------------------------------
// Claim checks
// ---------------------------------------------------------------------------

function claimsPass(payload: JwtPayload, opts: VerifyClerkJwtOptions, now: number): boolean {
  // Issuer must match exactly.
  if (payload.iss !== opts.issuer) {
    return false;
  }

  // Audience may be a string or an array; must include the expected audience.
  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.includes(opts.audience)) {
    return false;
  }

  // Expiry must be a number strictly in the future.
  if (typeof payload.exp !== "number" || !(payload.exp > now)) {
    return false;
  }

  // not-before, when present, must be <= now.
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number" || payload.nbf > now) {
      return false;
    }
  }

  // Subject must be a non-empty string.
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a Clerk-issued RS256 JWT against the configured JWKS, issuer, and
 * audience. Returns `{ sub, claims }` on success, or `null` on any failure.
 * Never throws.
 */
export async function verifyClerkJwt(
  token: string,
  opts: VerifyClerkJwtOptions,
): Promise<VerifiedClerkJwt | null> {
  try {
    const now = opts.now ?? Math.floor(Date.now() / 1000);

    // --- Parse the JWS: exactly three NON-EMPTY dot-separated segments. ---
    // (`"a..c"` splits to length 3 with an empty middle; reject it explicitly
    // rather than relying on a downstream JSON.parse throw to fail closed.)
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [seg0, seg1, seg2] = parts;
    if (!seg0 || !seg1 || !seg2) {
      return null;
    }

    const header = decodeJsonSegment<JwtHeader>(seg0);

    // --- ALG-CONFUSION GUARD (do FIRST, before any signature work). ---
    if (header.alg !== "RS256") {
      return null;
    }

    // --- Require an explicit kid: select keys by exact kid match only, never
    // fall back to "first signing key" for a kid-less token (defense-in-depth;
    // Clerk always emits a kid). ---
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      return null;
    }

    const payload = decodeJsonSegment<JwtPayload>(seg1);
    const signatureBuf = Buffer.from(seg2, "base64url");
    if (signatureBuf.length === 0) {
      return null;
    }

    // --- Resolve verifying key by kid, with one cache-bypassing refresh. ---
    let keys = await resolveJwks(opts.jwksUrl, opts.fetchJwks, false);
    let jwk = findKeyByKid(keys, header.kid);
    if (!jwk) {
      keys = await resolveJwks(opts.jwksUrl, opts.fetchJwks, true);
      jwk = findKeyByKid(keys, header.kid);
      if (!jwk) {
        return null;
      }
    }

    // --- Verify signature over the RAW encoded `header.payload`. ---
    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const signingInput = Buffer.from(`${seg0}.${seg1}`);
    const signatureValid = cryptoVerify("RSA-SHA256", signingInput, publicKey, signatureBuf);
    if (!signatureValid) {
      return null;
    }

    // --- Claim checks (all must pass). ---
    if (!claimsPass(payload, opts, now)) {
      return null;
    }

    return { sub: payload.sub as string, claims: payload as Record<string, unknown> };
  } catch {
    // Fail-closed: any unexpected error → null, never throw.
    return null;
  }
}
