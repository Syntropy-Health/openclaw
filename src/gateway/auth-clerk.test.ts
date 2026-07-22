// Wiring tests for the Clerk-JWT branch of the gateway bearer-auth seam.
//
// These exercise the FAIL-CLOSED invariants of the HTTP chat path (P1 Phase B,
// CTO ruling #1402 / chat-endpoint-contract §3). The pure RS256/JWKS verifier
// has its own unit suite (clerk-jwt.test.ts); here we test how it is WIRED into
// `authorizeGatewayConnect` — the downgrade/fail-open holes are the risk:
//
//   1. Clerk config present + a JWS-shaped bearer that fails verification → 401,
//      and it NEVER falls through to the shared-token comparison.
//   2. Clerk config ABSENT + a JWS-shaped bearer → the legacy shared-token path
//      is taken; a real JWS does not equal the shared secret, so it 401s (it is
//      never silently treated as "trusted").
//   3. Clerk config absent entirely → token/password/Tailscale behavior is
//      unchanged (behavior-preserving).
//   4. A NON-JWS bearer (the legacy shared token) authorizes normally even when
//      Clerk config is present — only a 3-part JWS routes to Clerk verify.
//
// Tokens are minted with a locally-generated RSA keypair and the JWKS is
// injected via `fetchClerkJwks` (no network), mirroring clerk-jwt.test.ts.

import { generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  authorizeClerkJwt,
  authorizeGatewayConnect,
  looksLikeJws,
  resolveGatewayAuth,
  type ResolvedClerkAuth,
} from "./auth.js";

// ---------------------------------------------------------------------------
// Token-minting helpers (local RSA keypair; no network)
// ---------------------------------------------------------------------------

const KID = "clerk-test-kid";
const ISSUER = "https://clerk.example.test";
const AUDIENCE = "shrinemobile";
const NOW = 1_750_000_000;

type JwkWithMeta = JsonWebKey & { kid?: string; alg?: string; use?: string };

function makeKeypair(kid: string): { privateKey: KeyObject; jwk: JwkWithMeta } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JwkWithMeta;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function mintToken(
  payload: Record<string, unknown>,
  opts: { kid: string; privateKey: KeyObject; alg?: string },
): string {
  const header = b64url({ alg: opts.alg ?? "RS256", kid: opts.kid, typ: "JWT" });
  const body = b64url(payload);
  const signingInput = `${header}.${body}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), opts.privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${signature}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: "user_2abc",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW + 3600,
    nbf: NOW - 60,
    ...overrides,
  };
}

// Claims anchored to the REAL clock — for `authorizeGatewayConnect` tests, which
// do not inject `now` into the verifier (it defaults to `Date.now()`).
function freshClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "user_2abc",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: now + 3600,
    nbf: now - 60,
    ...overrides,
  };
}

const { privateKey, jwk } = makeKeypair(KID);

function jwksFetcher(): (url: string) => Promise<{ keys: JsonWebKey[] }> {
  return async () => ({ keys: [jwk] });
}

const CLERK: ResolvedClerkAuth = {
  jwksUrl: "https://jwks.test/keys",
  issuer: ISSUER,
  audience: AUDIENCE,
};

// ---------------------------------------------------------------------------
// looksLikeJws — the routing predicate
// ---------------------------------------------------------------------------

describe("looksLikeJws", () => {
  it("is true only for exactly three NON-EMPTY dot segments", () => {
    expect(looksLikeJws("aaa.bbb.ccc")).toBe(true);
    expect(looksLikeJws("aaa.bbb")).toBe(false); // 2 parts
    expect(looksLikeJws("aaa.bbb.ccc.ddd")).toBe(false); // 4 parts
    expect(looksLikeJws("aaa..ccc")).toBe(false); // empty middle
    expect(looksLikeJws("plain-shared-token")).toBe(false); // legacy secret
    expect(looksLikeJws("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveGatewayAuth — Clerk config resolution (env + explicit, ALL-OR-NOTHING)
// ---------------------------------------------------------------------------

describe("resolveGatewayAuth — clerk config", () => {
  it("resolves clerk from OPENCLAW_CLERK_* env when all three present", () => {
    const auth = resolveGatewayAuth({
      authConfig: {},
      env: {
        OPENCLAW_CLERK_JWKS_URL: "https://jwks.test/keys",
        OPENCLAW_CLERK_ISSUER: ISSUER,
        OPENCLAW_CLERK_AUDIENCE: AUDIENCE,
      } as NodeJS.ProcessEnv,
    });
    expect(auth.clerk).toMatchObject({
      jwksUrl: "https://jwks.test/keys",
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    // §7.4b-A: no backend secret configured → session validation is OFF
    // (JWT-verify-only), but the config-knob TTL still resolves to its default.
    expect(auth.clerk?.sessionResolver).toBeUndefined();
    expect(auth.clerk?.sessionCacheTtlMs).toBe(30_000);
  });

  it("explicit authConfig.clerk takes precedence over env", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        clerk: { jwksUrl: "https://cfg/keys", issuer: "iss-cfg", audience: "aud-cfg" },
      },
      env: {
        OPENCLAW_CLERK_JWKS_URL: "https://env/keys",
        OPENCLAW_CLERK_ISSUER: "iss-env",
        OPENCLAW_CLERK_AUDIENCE: "aud-env",
      } as NodeJS.ProcessEnv,
    });
    expect(auth.clerk).toMatchObject({
      jwksUrl: "https://cfg/keys",
      issuer: "iss-cfg",
      audience: "aud-cfg",
    });
  });

  it("is undefined (disabled) when ANY of the three is missing — partial config never half-enables", () => {
    const partial = resolveGatewayAuth({
      authConfig: {},
      env: {
        OPENCLAW_CLERK_JWKS_URL: "https://jwks.test/keys",
        OPENCLAW_CLERK_ISSUER: ISSUER,
        // audience missing
      } as NodeJS.ProcessEnv,
    });
    expect(partial.clerk).toBeUndefined();
  });

  it("is undefined when no clerk config is supplied at all", () => {
    const auth = resolveGatewayAuth({ authConfig: {}, env: {} as NodeJS.ProcessEnv });
    expect(auth.clerk).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// authorizeClerkJwt — the verify→externalId adapter
// ---------------------------------------------------------------------------

describe("authorizeClerkJwt", () => {
  it("returns externalId = sub on a valid token", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const result = await authorizeClerkJwt(token, CLERK, { now: NOW, fetchJwks: jwksFetcher() });
    expect(result).toEqual({ ok: true, externalId: "user_2abc" });
  });

  it("fails closed (no externalId) on an invalid token", async () => {
    const token = mintToken(validClaims({ iss: "https://evil.test" }), { kid: KID, privateKey });
    const result = await authorizeClerkJwt(token, CLERK, { now: NOW, fetchJwks: jwksFetcher() });
    expect(result).toEqual({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// authorizeGatewayConnect — the fail-closed wiring invariants (the security core)
// ---------------------------------------------------------------------------

describe("authorizeGatewayConnect — clerk wiring (fail-closed invariants)", () => {
  // Legacy shared token used to prove no JWT downgrade / no JWT confusion.
  const SHARED = "shared-secret-token";

  it("INV-1: clerk present + valid JWS bearer → authorized, carries externalId=sub, never shared-token", async () => {
    const token = mintToken(freshClaims(), { kid: KID, privateKey });
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false, clerk: CLERK },
      connectAuth: { token },
      fetchClerkJwks: jwksFetcher(),
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("clerk-jwt");
    expect(res.externalId).toBe("user_2abc");
  });

  it("INV-1: clerk present + JWS bearer that FAILS verification → 401, does NOT fall through to shared-token", async () => {
    // A JWS whose claims are wrong (bad audience). Even though its raw string is
    // NOT the shared secret anyway, the point is it must be REJECTED as a clerk
    // attempt and never re-checked against the token path.
    const badToken = mintToken(validClaims({ aud: "wrong-audience" }), { kid: KID, privateKey });
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false, clerk: CLERK },
      connectAuth: { token: badToken },
      fetchClerkJwks: jwksFetcher(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("clerk_jwt_invalid");
    expect(res.externalId).toBeUndefined();
  });

  it("INV-1: an expired Clerk JWT fails closed (401), even though the verifier is wired", async () => {
    const expired = mintToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 3600 }), {
      kid: KID,
      privateKey,
    });
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false, clerk: CLERK },
      connectAuth: { token: expired },
      fetchClerkJwks: jwksFetcher(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("clerk_jwt_invalid");
  });

  it("INV-2: clerk ABSENT + a JWS-shaped bearer → legacy shared-token path; a real JWS != secret → 401 (never trusted)", async () => {
    const token = mintToken(freshClaims(), { kid: KID, privateKey });
    expect(looksLikeJws(token)).toBe(true); // it IS jws-shaped
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false /* clerk undefined */ },
      connectAuth: { token },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(res.method).toBeUndefined();
  });

  it("INV-3: clerk absent → a correct shared token still authorizes (behavior-preserving)", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false },
      connectAuth: { token: SHARED },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
    expect(res.externalId).toBeUndefined();
  });

  it("INV-4: clerk present + a NON-JWS legacy shared token → token path, authorizes (only 3-part JWS routes to clerk)", async () => {
    expect(looksLikeJws(SHARED)).toBe(false);
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false, clerk: CLERK },
      connectAuth: { token: SHARED },
      fetchClerkJwks: jwksFetcher(),
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
    expect(res.externalId).toBeUndefined();
  });

  it("INV-1: clerk present + a JWS bearer that is also (improbably) the shared secret → still routed to clerk and rejected", async () => {
    // Defense-in-depth: even if an operator set the shared token to a JWS-shaped
    // string, a JWS-shaped bearer is routed to Clerk verify (and fails) — it is
    // NOT silently accepted by the shared-token comparison.
    const jwsSharedSecret = "aaa.bbb.ccc"; // jws-shaped but not a real Clerk token
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: jwsSharedSecret, allowTailscale: false, clerk: CLERK },
      connectAuth: { token: jwsSharedSecret },
      fetchClerkJwks: jwksFetcher(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("clerk_jwt_invalid");
  });

  it("records a rate-limit failure on a failed clerk attempt and resets on success", async () => {
    const limiter = {
      check: vi.fn(() => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
      recordFailure: vi.fn(),
      reset: vi.fn(),
      size: () => 0,
      prune: () => {},
      dispose: () => {},
    };
    const bad = mintToken(validClaims({ aud: "nope" }), { kid: KID, privateKey });
    await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false, clerk: CLERK },
      connectAuth: { token: bad },
      rateLimiter: limiter as never,
      clientIp: "1.2.3.4",
      fetchClerkJwks: jwksFetcher(),
    });
    expect(limiter.recordFailure).toHaveBeenCalled();
    expect(limiter.reset).not.toHaveBeenCalled();

    const good = mintToken(freshClaims(), { kid: KID, privateKey });
    await authorizeGatewayConnect({
      auth: { mode: "token", token: SHARED, allowTailscale: false, clerk: CLERK },
      connectAuth: { token: good },
      rateLimiter: limiter as never,
      clientIp: "1.2.3.4",
      fetchClerkJwks: jwksFetcher(),
    });
    expect(limiter.reset).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// G-lane [G2b] — session revocation (sid deny-list) on the chat auth path
// ---------------------------------------------------------------------------

// NOTE: the sid deny-list revocation tests were REMOVED — that control is
// WITHDRAWN (A&D §7.4b-A). Revocation is now server-side session validation,
// covered by clerk-session-validation.test.ts + the live QA harness.
