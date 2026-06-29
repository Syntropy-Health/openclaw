// SEALED challenge suite — Clerk JWKS JWT verifier (AIADLC sealed-referee TDD).
//
// Authored double-blind by the `test-author` agent from the INTERFACE CONTRACT
// only. The implementer never sees this file; signal flows to them solely as the
// referee's coarse pass/fail-by-category.
//
// Module under test (contract): src/gateway/clerk-jwt.ts
//   verifyClerkJwt(token, {
//     jwksUrl, issuer, audience,
//     now?: number,                         // unix seconds; default Date.now()/1000
//     fetchJwks?: (url) => Promise<{ keys: JsonWebKey[] }>,  // injectable
//   }): Promise<{ sub: string; claims: Record<string, unknown> } | null>
//
// Contract invariant exercised throughout: verifyClerkJwt NEVER throws — every
// failure path resolves to `null`. Tokens are minted locally with node:crypto;
// no network is touched (fetchJwks is always injected).
//
// Categories (see MANIFEST.md), tagged in describe() blocks:
//   functional/verify-success   — valid tokens accepted
//   functional/verify-reject    — claim/signature failures rejected
//   functional/alg-confusion    — non-RS256 alg guard
//   functional/malformed        — structural decode failures
//   integration/jwks-fetch      — injected fetcher behavior
//
// OPEN QUESTION for principal (recorded per Hard Rule #3, not assumed in asserts):
//   The contract does not pin the `typ` header value or whether `aud` absence
//   (vs. mismatch) is distinguished. These suite cases do not assert on `typ`
//   and always supply `aud`, to avoid testing behavior the spec does not promise.

import { describe, it, expect, vi } from "vitest";
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { verifyClerkJwt } from "../../src/gateway/clerk-jwt.js";

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const ISSUER = "https://clerk.syntropyhealth.test";
const AUDIENCE = "syntropy-gateway";
const KID = "test-key-1";
// Fixed clock so every time-sensitive case is deterministic.
const NOW = 1_700_000_000;

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
// A second, unrelated keypair — used to produce signatures that must NOT verify
// against the published JWKS.
const { privateKey: wrongPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function b64url(json: unknown): string {
  return Buffer.from(JSON.stringify(json)).toString("base64url");
}

interface MintOpts {
  kid?: string;
  privateKey: KeyObject;
  alg?: string;
  /** When true, emit the `none` alg form (header.payload. with empty sig). */
  unsigned?: boolean;
  /** Override the signing algorithm passed to crypto independently of header alg. */
  signAlg?: string;
}

/** Build a JWS by hand so each case controls header/payload/signature exactly. */
function mintToken(
  claims: Record<string, unknown>,
  opts: MintOpts,
): string {
  const alg = opts.alg ?? "RS256";
  const header: Record<string, unknown> = { alg, typ: "JWT" };
  if (opts.kid !== undefined) {header.kid = opts.kid;}
  const headerSeg = b64url(header);
  const payloadSeg = b64url(claims);
  const signingInput = `${headerSeg}.${payloadSeg}`;
  if (opts.unsigned) {
    // alg:"none" → empty signature segment.
    return `${signingInput}.`;
  }
  const sigAlg = opts.signAlg ?? "RSA-SHA256";
  const sig = cryptoSign(sigAlg, Buffer.from(signingInput), opts.privateKey);
  return `${signingInput}.${sig.toString("base64url")}`;
}

/** Publish the public key as a single-entry JWKS the verifier should consult. */
function makeJwks(pub: KeyObject, kid: string): { keys: JsonWebKey[] } {
  const jwk = pub.export({ format: "jwk" }) as JsonWebKey & Record<string, unknown>;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { keys: [jwk] };
}

const JWKS = makeJwks(publicKey, KID);

/** Standard injected fetcher returning the published JWKS. */
function jwksFetcher() {
  return vi.fn(async (_url: string) => JWKS);
}

/** Default opts for a happy-path verification. */
function baseOpts(extra?: Partial<Parameters<typeof verifyClerkJwt>[1]>) {
  return {
    jwksUrl: "https://jwks.example.test/.well-known/jwks.json",
    issuer: ISSUER,
    audience: AUDIENCE,
    now: NOW,
    fetchJwks: jwksFetcher(),
    ...extra,
  };
}

/** Default valid claim set. */
function validClaims(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    sub: "user_abc",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW + 3600,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// functional/verify-success
// ---------------------------------------------------------------------------

describe("functional/verify-success", () => {
  it("accepts a valid RS256 token and returns { sub, claims }", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const result = await verifyClerkJwt(token, baseOpts());
    expect(result).not.toBeNull();
    expect(result?.sub).toBe("user_abc");
    expect(result?.claims).toMatchObject({ iss: ISSUER, sub: "user_abc" });
  });

  it("accepts when aud is an array including the configured audience", async () => {
    const token = mintToken(
      validClaims({ aud: ["other-svc", AUDIENCE, "third"] }),
      { kid: KID, privateKey },
    );
    const result = await verifyClerkJwt(token, baseOpts());
    expect(result).not.toBeNull();
    expect(result?.sub).toBe("user_abc");
  });

  it("accepts when nbf is in the past (already valid)", async () => {
    const token = mintToken(validClaims({ nbf: NOW - 60 }), {
      kid: KID,
      privateKey,
    });
    const result = await verifyClerkJwt(token, baseOpts());
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// functional/verify-reject
// ---------------------------------------------------------------------------

describe("functional/verify-reject", () => {
  it("rejects a token whose aud does not include the audience → null", async () => {
    const token = mintToken(validClaims({ aud: "some-other-service" }), {
      kid: KID,
      privateKey,
    });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects an aud array that omits the audience → null", async () => {
    const token = mintToken(validClaims({ aud: ["a", "b", "c"] }), {
      kid: KID,
      privateKey,
    });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects a wrong issuer → null", async () => {
    const token = mintToken(
      validClaims({ iss: "https://evil.issuer.test" }),
      { kid: KID, privateKey },
    );
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects an expired token (exp <= now) → null", async () => {
    const token = mintToken(validClaims({ exp: NOW - 1 }), {
      kid: KID,
      privateKey,
    });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects a token not yet valid (nbf > now) → null", async () => {
    const token = mintToken(validClaims({ nbf: NOW + 600 }), {
      kid: KID,
      privateKey,
    });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects a token missing the sub claim → null", async () => {
    const claims = validClaims();
    delete (claims).sub;
    const token = mintToken(claims, { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects a signature made with the wrong key → null", async () => {
    const token = mintToken(validClaims(), {
      kid: KID,
      privateKey: wrongPrivateKey,
    });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects a tampered signature segment (flipped char) → null", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const [h, p, s] = token.split(".");
    const flipped = (s[0] === "A" ? "B" : "A") + s.slice(1);
    const tampered = `${h}.${p}.${flipped}`;
    expect(await verifyClerkJwt(tampered, baseOpts())).toBeNull();
  });

  it("rejects a tampered payload reusing the old signature → null", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const [h, , s] = token.split(".");
    // Re-encode a payload that elevates privileges but keep the original sig.
    const forgedPayload = b64url(validClaims({ sub: "user_admin" }));
    const forged = `${h}.${forgedPayload}.${s}`;
    expect(await verifyClerkJwt(forged, baseOpts())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// functional/alg-confusion
// ---------------------------------------------------------------------------

describe("functional/alg-confusion", () => {
  it('rejects header alg "HS256" → null', async () => {
    // HMAC-shaped token: sign the input with the JWK's public modulus bytes as a
    // secret would be the classic attack; here we simply assert the alg guard
    // fires before any verification, so any signature bytes must be rejected.
    const headerSeg = b64url({ alg: "HS256", typ: "JWT", kid: KID });
    const payloadSeg = b64url(validClaims());
    const fakeSig = Buffer.from("not-a-real-hs256-mac").toString("base64url");
    const token = `${headerSeg}.${payloadSeg}.${fakeSig}`;
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it('rejects header alg "none" → null', async () => {
    const token = mintToken(validClaims(), {
      kid: KID,
      privateKey,
      alg: "none",
      unsigned: true,
    });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// functional/malformed
// ---------------------------------------------------------------------------

describe("functional/malformed", () => {
  it('rejects "not.a.jwt" → null', async () => {
    expect(await verifyClerkJwt("not.a.jwt", baseOpts())).toBeNull();
  });

  it('rejects "abc" (no segments) → null', async () => {
    expect(await verifyClerkJwt("abc", baseOpts())).toBeNull();
  });

  it("rejects an empty string → null", async () => {
    expect(await verifyClerkJwt("", baseOpts())).toBeNull();
  });

  it("rejects a token with a non-JSON header segment → null", async () => {
    const badHeader = Buffer.from("this-is-not-json").toString("base64url");
    const payloadSeg = b64url(validClaims());
    const token = `${badHeader}.${payloadSeg}.${"AAAA"}`;
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects a token with a non-JSON payload segment → null", async () => {
    const headerSeg = b64url({ alg: "RS256", typ: "JWT", kid: KID });
    const badPayload = Buffer.from("nope").toString("base64url");
    const token = `${headerSeg}.${badPayload}.${"AAAA"}`;
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// integration/jwks-fetch
// ---------------------------------------------------------------------------

describe("integration/jwks-fetch", () => {
  it("returns null when the header kid has no matching JWK", async () => {
    const token = mintToken(validClaims(), {
      kid: "some-unknown-kid",
      privateKey,
    });
    // Fetcher returns a JWKS that lacks the requested kid.
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("returns null when the fetched JWKS lacks the kid entirely", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const fetchJwks = vi.fn(async (_url: string) => ({ keys: [] }));
    expect(await verifyClerkJwt(token, baseOpts({ fetchJwks }))).toBeNull();
  });

  it("invokes the injected fetchJwks during a valid verification", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const fetchJwks = vi.fn(async (_url: string) => JWKS);
    const result = await verifyClerkJwt(token, baseOpts({ fetchJwks }));
    expect(result).not.toBeNull();
    expect(fetchJwks).toHaveBeenCalled();
  });
});
