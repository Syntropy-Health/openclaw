// Coverage tests for the Clerk JWKS RS256 verifier — the QG-coverage companion
// to the sealed challenge suite (tests/sealed/clerk-jwt.sealed.test.ts).
//
// These target the branches/boundaries the quality-gate test review surfaced:
// claim type-confusion (aud number/object, sub number/empty), exact temporal
// boundaries (exp===now reject, nbf===now accept), the JWKS doc type guard
// (non-array `keys`), fail-closed on a throwing fetcher, EXACT fetch-call-count
// (1 on the happy path, 2 on one-refresh recovery), cross-key substitution,
// and the empty-segment + required-kid guards added during the QG.

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyClerkJwt } from "./clerk-jwt.js";

const NOW = 1_700_000_000;
const ISSUER = "https://clerk.syntropyhealth.test";
const AUDIENCE = "syntropy-gateway";
const KID = "test-kid-1";
const JWKS_URL = "https://clerk.syntropyhealth.test/.well-known/jwks.json";

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
  claims: Record<string, unknown>,
  opts: { kid: string; privateKey: KeyObject; alg?: string },
): string {
  const header = b64url({ alg: opts.alg ?? "RS256", kid: opts.kid, typ: "JWT" });
  const payload = b64url(claims);
  const signingInput = `${header}.${payload}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(signingInput), opts.privateKey).toString(
    "base64url",
  );
  return `${signingInput}.${sig}`;
}

function validClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sub: "user_abc", iss: ISSUER, aud: AUDIENCE, exp: NOW + 3600, ...over };
}

const { privateKey, jwk } = makeKeypair(KID);

function jwksFetcher(keys: JsonWebKey[] = [jwk]): (url: string) => Promise<{ keys: JsonWebKey[] }> {
  return async () => ({ keys });
}

function baseOpts(over: Partial<Parameters<typeof verifyClerkJwt>[1]> = {}) {
  return {
    jwksUrl: JWKS_URL,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: NOW,
    fetchJwks: jwksFetcher(),
    ...over,
  };
}

describe("clerk-jwt — claim type-confusion", () => {
  it("rejects aud as a number", async () => {
    const token = mintToken(validClaims({ aud: 123 }), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects aud as an object", async () => {
    const token = mintToken(validClaims({ aud: { x: 1 } }), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects sub as a number", async () => {
    const token = mintToken(validClaims({ sub: 12345 }), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects sub as an empty string", async () => {
    const token = mintToken(validClaims({ sub: "" }), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });
});

describe("clerk-jwt — temporal boundaries", () => {
  it("rejects exp === now (must be strictly in the future)", async () => {
    const token = mintToken(validClaims({ exp: NOW }), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("accepts nbf === now", async () => {
    const token = mintToken(validClaims({ nbf: NOW }), { kid: KID, privateKey });
    const result = await verifyClerkJwt(token, baseOpts());
    expect(result?.sub).toBe("user_abc");
  });

  it("rejects exp as a non-number", async () => {
    const token = mintToken(validClaims({ exp: "9999999999" }), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });
});

describe("clerk-jwt — JWKS doc / fetcher robustness", () => {
  it("rejects when the JWKS doc has a non-array keys field", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const fetchJwks = vi.fn(
      async () =>
        ({ keys: "not-an-array" }) as unknown as {
          keys: JsonWebKey[];
        },
    );
    expect(await verifyClerkJwt(token, baseOpts({ fetchJwks }))).toBeNull();
  });

  it("fails closed when the fetcher throws", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const fetchJwks = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await verifyClerkJwt(token, baseOpts({ fetchJwks }))).toBeNull();
  });
});

describe("clerk-jwt — fetch call-count bounds", () => {
  it("calls the fetcher exactly once on the happy path (kid found first)", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const fetchJwks = vi.fn(jwksFetcher());
    const result = await verifyClerkJwt(token, baseOpts({ fetchJwks }));
    expect(result?.sub).toBe("user_abc");
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("calls the fetcher exactly twice on one-refresh recovery (kid appears after refresh)", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    let call = 0;
    const fetchJwks = vi.fn(async () => {
      call += 1;
      return { keys: call === 1 ? [] : [jwk] }; // empty first, key on refresh
    });
    const result = await verifyClerkJwt(token, baseOpts({ fetchJwks }));
    expect(result?.sub).toBe("user_abc");
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("calls the fetcher exactly twice then gives up when the kid never appears", async () => {
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    const fetchJwks = vi.fn(async () => ({ keys: [] as JsonWebKey[] }));
    const result = await verifyClerkJwt(token, baseOpts({ fetchJwks }));
    expect(result).toBeNull();
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
});

describe("clerk-jwt — key substitution & guards", () => {
  it("rejects a token signed by a different kid's key (cross-key substitution)", async () => {
    // Token header claims KID but is signed with a foreign private key; the JWKS
    // returns the real KID public key, so the signature must fail to verify.
    const foreign = makeKeypair("other-kid");
    const token = mintToken(validClaims(), { kid: KID, privateKey: foreign.privateKey });
    expect(await verifyClerkJwt(token, baseOpts())).toBeNull();
  });

  it("rejects an enc-use key even if the kid matches", async () => {
    const encJwk: JwkWithMeta = { ...jwk, use: "enc" };
    const token = mintToken(validClaims(), { kid: KID, privateKey });
    expect(await verifyClerkJwt(token, baseOpts({ fetchJwks: jwksFetcher([encJwk]) }))).toBeNull();
  });

  it("rejects a token with an empty middle segment (a..c)", async () => {
    expect(await verifyClerkJwt("YWJj..YWJj", baseOpts())).toBeNull();
  });

  it("rejects a token whose header omits kid", async () => {
    const header = b64url({ alg: "RS256", typ: "JWT" }); // no kid
    const payload = b64url(validClaims());
    const signingInput = `${header}.${payload}`;
    const sig = cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString(
      "base64url",
    );
    expect(await verifyClerkJwt(`${signingInput}.${sig}`, baseOpts())).toBeNull();
  });
});
