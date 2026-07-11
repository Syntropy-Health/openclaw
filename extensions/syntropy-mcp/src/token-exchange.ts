/**
 * TokenExchangeClient — the RFC 8693 client half of per-user auth (B2).
 *
 * openclaw's `m2m-exchange` MCP servers need a **user-scoped** token to call a
 * backend on behalf of the current human. This client performs the OAuth 2.0
 * Token Exchange (RFC 8693) against the backend's exchange endpoint, using the
 * gateway's own M2M JWT (from {@link ServiceAuthProvider}) as the `actor_token`
 * and EITHER the user's live Clerk JWT (Tier 1, `subject_token`) OR a
 * channel-scoped subject (Tier 2, `requested_subject` = `"<channel>:<externalId>"`).
 * SJ's security QG removed the bare-`externalId` Tier-2 path (no consent artifact
 * = impersonation surface), so a Tier-2 subject is always channel-scoped.
 *
 * The response is an **SJ-minted RS256 JWT** (CTO-ruled Option B, #2924): SJ
 * signs it with its own key and serves its own JWKS at `{baseUrl}{jwksPath}`.
 * This client:
 *   - VALIDATES the minted token BEFORE caching — RS256 signature against SJ's
 *     JWKS (via {@link createJwksVerifier}: alg-pinned RS256, 300s keyset cache,
 *     unknown-kid fail-closed) AND the binding claims (`sub`=={@link subjectId},
 *     `act.sub`==machineSub, `aud`==resource, `iss`==issuer, `exp` future, `nbf`
 *     not-future). A token failing ANY check is NEVER cached and NEVER returned —
 *     the call throws a structured {@link TokenExchangeError}.
 *   - CACHES per {@link subjectId} (Tier-2 channel-scoped, so the same externalId
 *     on two channels never shares a token), with a refresh skew, TTL driven
 *     DYNAMICALLY by the response `expires_in` (SJ ≤900s — never hardcoded).
 *   - SINGLE-FLIGHTS concurrent exchanges for the same subject key.
 *   - {@link invalidate}s a subject's cache on a downstream 401 so the next call
 *     re-exchanges (the retry itself lives in the tool execute path).
 *
 * **Token / PII hygiene:** no `access_token`, `actor_token`, `subject_token`,
 * or raw `externalId` (a Clerk user id = PII) ever appears in a thrown error —
 * the externalId is redacted to a short non-reversible hash for correlation only.
 */

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TokenExchangeConfig = {
  serverId: string;
  baseUrl: string;
  /** Exchange endpoint path; default "/api/tokens/exchange". */
  exchangePath: string;
  /** Canonical /mcp URI == expected `aud` on the minted token. */
  resource: string;
  /** JWKS path; default "/api/mcp/.well-known/jwks.json". */
  jwksPath?: string;
  /** Expected `act.sub` on the minted token (the gateway machine sub). */
  machineSub: string;
  /**
   * Expected `iss` on the minted token (SJ base / issuer URL). Required —
   * fail-closed if the token's `iss` is missing or mismatched. Trailing-slash
   * tolerant (compared after stripping a single trailing "/").
   */
  issuer: string;
};

export type ExchangeSubject =
  | { tier: 1; externalId: string; userJwt: string } // subject_token (Clerk JWT / HTTP)
  | { tier: 2; externalId: string; channel: string }; // requested_subject = "<channel>:<externalId>"

/**
 * The identity the minted token's `sub` is bound to (and the Tier-2 wire
 * `requested_subject`). SJ's security QG removed the bare-`externalId` Tier-2
 * path (no consent artifact = impersonation surface), so a Tier-2 subject is
 * scoped by channel: `"<channel>:<externalId>"` (e.g. `"telegram:12345"`).
 * Tier-1 stays the bare `externalId` (the Clerk-JWT/HTTP path).
 */
export function subjectId(subject: ExchangeSubject): string {
  return subject.tier === 2 ? `${subject.channel}:${subject.externalId}` : subject.externalId;
}

/**
 * Verify a minted RS256 JWT against the JWKS at `jwksUrl`, returning its claims.
 * Injectable so tests decode a fake JWT and production verifies the signature.
 * MUST throw (reject) on any signature/parse failure — the client treats a
 * resolved value as an authentic token whose claims it then binds-checks.
 */
export type VerifyMintedTokenFn = (
  jwt: string,
  jwksUrl: string,
) => Promise<Record<string, unknown>>;

export type TokenExchangeOptions = {
  /** The gateway M2M JWT (the `actor_token`), from a ServiceAuthProvider. */
  getActorToken: () => Promise<string>;
  /** Injectable transport (tests); defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injectable JWKS verify seam; defaults to an RS256/`node:crypto` verifier. */
  verifyMintedToken?: VerifyMintedTokenFn;
  /** Injectable clock (epoch ms); defaults to `Date.now`. */
  now?: () => number;
};

/** A structured, hygiene-safe error. `code` classifies the failure. */
export class TokenExchangeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TokenExchangeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_JWKS_PATH = "/api/mcp/.well-known/jwks.json";
const REFRESH_SKEW_MS = 60_000;
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";
const EXCHANGE_TIMEOUT_MS = 15_000;
/** JWKS keyset cache max-age. Rotation safety = SJ serving old+new kids across
 *  this window + natural expiry pickup (devex: NO cache-bypassing kid refetch). */
const JWKS_MAX_AGE_MS = 300_000;

/** RFC 6749 error codes we surface unchanged; anything else → "invalid_grant". */
const RFC6749_ERRORS = new Set(["invalid_grant", "invalid_request", "unauthorized_client"]);

// ---------------------------------------------------------------------------
// Redaction — never leak the raw Clerk user id (PII) or any token value.
// ---------------------------------------------------------------------------

/** Short, stable, non-reversible tag for an externalId (correlation only). */
function redactId(externalId: string): string {
  return `uid#${createHash("sha256").update(externalId).digest("hex").slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Default verify seam — RS256 against SJ's JWKS, zero external deps.
// ---------------------------------------------------------------------------

type Jwks = { keys?: JsonWebKey[] };

/** Injectable JWKS source; default fetches + parses over `fetch`. */
export type JwksFetchFn = (url: string) => Promise<Jwks>;

export type JwksVerifierOptions = {
  /** Injectable JWKS fetcher (tests). Default: real `fetch` → JSON. */
  fetchJwks?: JwksFetchFn;
  /** Injectable clock (epoch ms) — drives the JWKS cache max-age. Default `Date.now`. */
  now?: () => number;
  /** Keyset cache max-age (ms). Default 300s. */
  maxAgeMs?: number;
};

/**
 * Base64url-decode a JWT segment to a JSON OBJECT. Fail-closed
 * ({@link TokenExchangeError}) on a parse error OR a non-object payload
 * (`null` / array / primitive) — so a malformed token can never reach the claim
 * checks as a raw `TypeError` (CODE-DECODE-GUARD).
 */
function decodeSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new TokenExchangeError("invalid_token", "minted token segment is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TokenExchangeError("invalid_token", "minted token segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Default real JWKS fetcher — fail-closed (throws) on any non-2xx / parse error. */
const defaultFetchJwks: JwksFetchFn = async (url) => {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new TokenExchangeError("invalid_token", `JWKS fetch failed (${res.status})`);
  }
  return (await res.json()) as Jwks;
};

/**
 * Build the DEFAULT minted-token verifier — the security kernel of the exchange
 * (devex condition-of-approval). Verifies an RS256 signature against SJ's JWKS
 * with `node:crypto` and returns the raw claims (binding claims — sub/act.sub/
 * aud/exp/iss/nbf — are the client's job). Throws on ANY failure so the client's
 * fail-closed contract holds. Non-obvious, deliberate security properties:
 *
 *  - **ALG hard-pin (anti algorithm-confusion):** `alg` MUST be `RS256`. `none`
 *    and `HS256` (the HMAC-with-the-public-key attack) are rejected on the header
 *    BEFORE any JWKS fetch or key work — the fetcher is never invoked for them.
 *  - **JWKS cache (max-age 300s, injectable clock):** the keyset is fetched at
 *    most once per `maxAgeMs`; verifies inside the window reuse the cached keys.
 *  - **Unknown-kid FAIL-CLOSED (NO fetch-and-trust):** a `kid` absent from the
 *    currently-cached keyset is rejected. We do NOT trigger a cache-bypassing
 *    refetch to "find" an arbitrary kid — rotation safety is SJ serving old+new
 *    kids during the overlap window + the natural 300s expiry. (This is distinct
 *    from the CLIENT's invalidate + re-exchange on a tool-call 401, which stays.)
 */
export function createJwksVerifier(opts: JwksVerifierOptions = {}): VerifyMintedTokenFn {
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? JWKS_MAX_AGE_MS;
  // Per-verifier keyset cache, keyed by jwksUrl.
  const cache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>();
  // In-flight JWKS fetches, keyed by jwksUrl — N cold concurrent verifies share
  // ONE fetch rather than stampeding the JWKS endpoint (CODE-JWKS-SINGLEFLIGHT).
  const inFlightJwks = new Map<string, Promise<JsonWebKey[]>>();

  const resolveKeys = async (jwksUrl: string): Promise<JsonWebKey[]> => {
    const entry = cache.get(jwksUrl);
    if (entry && now() - entry.fetchedAt < maxAgeMs) return entry.keys;

    const existing = inFlightJwks.get(jwksUrl);
    if (existing) return existing;

    const flight = (async (): Promise<JsonWebKey[]> => {
      let jwks: Jwks;
      try {
        jwks = await fetchJwks(jwksUrl);
      } catch (err) {
        // Fail-closed: any JWKS fetch failure → no keys accepted. Never echo the
        // underlying cause (could carry a URL/credential); re-wrap structurally.
        if (err instanceof TokenExchangeError) throw err;
        throw new TokenExchangeError("invalid_token", "JWKS fetch failed");
      }
      const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
      // SEC-EMPTY-JWKS: never cache an empty keyset — a transient 200 {keys:[]}
      // would 300s-self-DoS after SJ recovers. Return it (→ unknown-kid reject)
      // but force the NEXT verify to refetch.
      if (keys.length > 0) cache.set(jwksUrl, { keys, fetchedAt: now() });
      return keys;
    })().finally(() => {
      inFlightJwks.delete(jwksUrl);
    });
    inFlightJwks.set(jwksUrl, flight);
    return flight;
  };

  return async (jwt, jwksUrl) => {
    const parts = jwt.split(".");
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new TokenExchangeError("invalid_token", "minted token is not a well-formed JWS");
    }
    const header = decodeSegment(parts[0]) as { alg?: string; kid?: string };
    // ALG hard-pin FIRST — before any fetch/key work (anti algorithm-confusion).
    if (header.alg !== "RS256") {
      throw new TokenExchangeError("invalid_token", "minted token alg is not RS256");
    }
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      throw new TokenExchangeError("invalid_token", "minted token has no kid");
    }

    // Only NOW may we touch the JWKS (cache-first).
    const keys = await resolveKeys(jwksUrl);
    const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
    if (!jwk) {
      // Unknown kid → FAIL CLOSED. No cache-bypassing refetch (devex).
      throw new TokenExchangeError("invalid_token", "minted token kid not in the cached JWKS");
    }

    const publicKey = createPublicKey({ key: jwk, format: "jwk" });
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], "base64url");
    if (signature.length === 0 || !cryptoVerify("RSA-SHA256", signingInput, publicKey, signature)) {
      throw new TokenExchangeError("invalid_token", "minted token signature is invalid");
    }
    return decodeSegment(parts[1]);
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type CachedToken = { token: string; expiresAtMs: number };

export class TokenExchangeClient {
  private readonly cfg: TokenExchangeConfig;
  private readonly getActorToken: () => Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly verifyMintedToken: VerifyMintedTokenFn;
  private readonly now: () => number;
  private readonly jwksUrl: string;

  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<string, Promise<string>>();
  // Per-key monotonic generation (mirrors ServiceAuthProvider): bumped by
  // invalidate(); an exchange dispatched under an older generation must NOT
  // repopulate the cache when it resolves (DESIGN-GENGUARD) — otherwise an
  // invalidate() racing an in-flight exchange (the post-401 case) would
  // resurrect the just-dropped token.
  private readonly generations = new Map<string, number>();

  constructor(cfg: TokenExchangeConfig, opts: TokenExchangeOptions) {
    this.cfg = cfg;
    this.getActorToken = opts.getActorToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    // The default verifier shares the client's clock so its JWKS cache max-age
    // is driven by the same (injectable) time source.
    this.verifyMintedToken = opts.verifyMintedToken ?? createJwksVerifier({ now: this.now });
    const jwksPath = cfg.jwksPath ?? DEFAULT_JWKS_PATH;
    this.jwksUrl = `${cfg.baseUrl}${jwksPath}`;
  }

  /**
   * Exchange for a user-scoped token, caching per {@link subjectId} (Tier-2 is
   * channel-scoped `"<channel>:<externalId>"`, so the same externalId on two
   * channels never shares a token). Returns the validated `access_token`.
   * Single-flighted per subject key.
   */
  async getUserToken(subject: ExchangeSubject): Promise<string> {
    const key = subjectId(subject);

    const cached = this.cache.get(key);
    if (cached && this.now() < cached.expiresAtMs - REFRESH_SKEW_MS) {
      return cached.token;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    // Capture the generation at flight start; a racing invalidate() bumps it and
    // this resolve must then NOT cache (DESIGN-GENGUARD).
    const flightGen = this.generations.get(key) ?? 0;
    const flight = this.exchange(subject)
      .then((minted) => {
        // Cache ONLY after validation succeeded (exchange() throws otherwise)
        // AND only if no invalidate() bumped the generation while in flight.
        if ((this.generations.get(key) ?? 0) === flightGen) this.cache.set(key, minted);
        return minted.token;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, flight);
    return flight;
  }

  /**
   * Drop a cached token (call on a downstream 401). `key` is the {@link subjectId}
   * — for Tier-2 the channel-scoped `"<channel>:<externalId>"`, for Tier-1 the
   * bare externalId. Bumps the key's generation so an exchange already in flight
   * cannot resurrect the dropped token when it resolves (DESIGN-GENGUARD).
   */
  invalidate(key: string): void {
    this.cache.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  /**
   * Evict cached tokens whose absolute expiry has passed. The plugin calls this
   * on its periodic refresh tick so the per-subject cache stays bounded (the
   * client owns no timer — mirrors the catalog's "never self-schedule" rule).
   */
  sweepExpired(): void {
    const nowMs = this.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAtMs <= nowMs) this.cache.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async exchange(subject: ExchangeSubject): Promise<CachedToken> {
    const idTag = redactId(subject.externalId);

    let actorToken: string;
    try {
      actorToken = await this.getActorToken();
    } catch (err) {
      // Never interpolate the underlying provider message (may carry secrets).
      throw new TokenExchangeError(
        "actor_token",
        `${this.cfg.serverId}: could not obtain actor token for ${idTag} — ${errKind(err)}`,
      );
    }

    const body = new URLSearchParams();
    body.set("grant_type", GRANT_TYPE);
    body.set("actor_token", actorToken);
    body.set("actor_token_type", TOKEN_TYPE_JWT);
    body.set("resource", this.cfg.resource);
    if (subject.tier === 1) {
      body.set("subject_token", subject.userJwt);
      body.set("subject_token_type", TOKEN_TYPE_JWT);
    } else {
      // Tier-2 is channel-scoped: "<channel>:<externalId>" (SJ security QG).
      body.set("requested_subject", subjectId(subject));
    }

    const url = `${this.cfg.baseUrl}${this.cfg.exchangePath}`;
    let resp: Response;
    try {
      resp = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch {
      // Swallow the raw cause — a network error message can echo the request
      // (and thus the actor/subject token). Surface a generic, safe message.
      throw new TokenExchangeError(
        "network",
        `${this.cfg.serverId}: token exchange request failed for ${idTag}`,
      );
    }

    if (!resp.ok) {
      const code = await readRfcErrorCode(resp);
      throw new TokenExchangeError(
        code,
        `${this.cfg.serverId}: token exchange rejected (${resp.status}/${code}) for ${idTag}`,
      );
    }

    let json: Record<string, unknown>;
    try {
      json = (await resp.json()) as Record<string, unknown>;
    } catch {
      throw new TokenExchangeError(
        "invalid_response",
        `${this.cfg.serverId}: token exchange returned a non-JSON body for ${idTag}`,
      );
    }

    const accessToken = json.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new TokenExchangeError(
        "invalid_response",
        `${this.cfg.serverId}: token exchange response had no access_token for ${idTag}`,
      );
    }

    // --- VALIDATE BEFORE CACHE: signature (Option B RS256/JWKS) then claims. ---
    let claims: Record<string, unknown>;
    try {
      claims = await this.verifyMintedToken(accessToken, this.jwksUrl);
    } catch {
      // Never echo the token or the verifier's raw message.
      throw new TokenExchangeError(
        "invalid_token",
        `${this.cfg.serverId}: minted token failed signature verification for ${idTag}`,
      );
    }

    this.checkClaims(claims, subject, idTag);

    const expiresAtMs = this.deriveExpiry(claims, json.expires_in);
    return { token: accessToken, expiresAtMs };
  }

  /**
   * Enforce the request↔token binding claims — the credential-binding integrity
   * point. Throws a hygiene-safe {@link TokenExchangeError} (never the token, the
   * claim values, or the raw externalId) on any mismatch. The `sub` binding
   * DIFFERS by tier (SJ mint contract, #2951):
   *
   *  - **Tier 1** (subject_token = Clerk JWT): `sub` == the request `externalId`
   *    (the bare Clerk `sub` rides straight through the exchange).
   *  - **Tier 2** (requested_subject = "<channel>:<externalId>"): SJ RESOLVES the
   *    composed request through the passcode linkage to the real Clerk user, so
   *    the minted `sub` is that resolved Clerk user_id — NOT the composed value,
   *    and NOT predictable by this client. We therefore require `sub` be a
   *    non-empty string (the downstream user_scope) but do NOT bind it; the
   *    request↔token integrity binding is `channel` == the requested channel,
   *    plus `tier` == 2 (a Tier-1 token can't satisfy a Tier-2 request path).
   *    Cross-user isolation is preserved by the cache key ({@link subjectId} =
   *    "<channel>:<externalId>"), which is unchanged.
   */
  private checkClaims(
    claims: Record<string, unknown>,
    subject: ExchangeSubject,
    idTag: string,
  ): void {
    const fail = (detail: string): never => {
      throw new TokenExchangeError(
        "claim_mismatch",
        `${this.cfg.serverId}: minted token ${detail} for ${idTag}`,
      );
    };

    if (subject.tier === 1) {
      // The bare externalId IS the Clerk `sub` on the JWT path. `tier` is a JSON
      // NUMBER (not "1") — also assert it so a Tier-2 token can't satisfy the
      // Tier-1 path. Tier-1 mints carry NO `channel` claim (do not assert one).
      if (claims.sub !== subject.externalId) fail("sub does not match the requested subject");
      if (claims.tier !== 1) fail("tier is not 1 for a Tier-1 request");
    } else {
      // Tier 2: `sub` is the SJ-resolved Clerk user_id (unpredictable) — require
      // it present, but bind integrity via `channel` + `tier` instead. `tier` is
      // a JSON NUMBER (=== 2, NOT "2"); `channel` is a top-level string == the
      // requested channel (the bare channel, e.g. "whatsapp").
      if (typeof claims.sub !== "string" || claims.sub.length === 0) {
        fail("sub is missing or empty");
      }
      if (claims.channel !== subject.channel) fail("channel does not match the requested channel");
      if (claims.tier !== 2) fail("tier is not 2 for a Tier-2 request");
    }

    const act = claims.act;
    const actSub =
      act && typeof act === "object" ? (act as Record<string, unknown>).sub : undefined;
    if (actSub !== this.cfg.machineSub) fail("act.sub does not match the gateway machine sub");

    const aud = claims.aud;
    const audOk = Array.isArray(aud) ? aud.includes(this.cfg.resource) : aud === this.cfg.resource;
    if (!audOk) fail("aud does not match the server resource");

    // iss MUST match (fail-closed if missing/mismatched); trailing-slash tolerant.
    const iss = claims.iss;
    if (typeof iss !== "string" || stripSlash(iss) !== stripSlash(this.cfg.issuer)) {
      fail("iss is missing or does not match the expected issuer");
    }

    const exp = claims.exp;
    if (typeof exp !== "number" || !(exp * 1000 > this.now())) {
      fail("exp is missing or in the past");
    }

    // nbf, when present, must be <= now (reject a not-yet-valid token). Absent OK.
    const nbf = claims.nbf;
    if (nbf !== undefined && (typeof nbf !== "number" || nbf * 1000 > this.now())) {
      fail("nbf is in the future (token not yet valid)");
    }
  }

  /**
   * Absolute expiry (epoch ms). Driven by the response's `expires_in` (SJ issues
   * ≤900s — never a hardcoded lifetime here) but CLAMPED to the token's signed
   * `exp` claim: `min(now+expires_in, exp)` (SEC-EXPCLAMP). The unsigned
   * `expires_in` transport field must never extend a token's cached lifetime
   * beyond what the signature attests. When `expires_in` is absent/≤0, fall back
   * to `exp` alone (guaranteed a valid future number by {@link checkClaims}).
   */
  private deriveExpiry(claims: Record<string, unknown>, expiresInRaw: unknown): number {
    const exp = claims.exp;
    const expClaimMs = typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
    const expiresInMs =
      typeof expiresInRaw === "number" && expiresInRaw > 0
        ? this.now() + expiresInRaw * 1000
        : undefined;
    if (expiresInMs !== undefined && expClaimMs !== undefined) {
      return Math.min(expiresInMs, expClaimMs);
    }
    // Unreachable fallthrough to now(): checkClaims enforces a valid future exp.
    return expiresInMs ?? expClaimMs ?? this.now();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Coarse error kind for logging — never the message (may carry a token). */
function errKind(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

/** Strip a single trailing "/" for trailing-slash-tolerant issuer comparison. */
function stripSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Extract the RFC 6749 `error` code from a rejection body, mapping unknown /
 * absent codes to `invalid_grant`. Never returns free-form body text (which
 * could echo a token) — only a fixed vocabulary code.
 */
async function readRfcErrorCode(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: unknown };
    if (typeof body.error === "string" && RFC6749_ERRORS.has(body.error)) return body.error;
  } catch {
    // fall through
  }
  return "invalid_grant";
}
