import { createSign, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createJwksVerifier,
  type ExchangeSubject,
  subjectId,
  TokenExchangeClient,
  type TokenExchangeConfig,
  TokenExchangeError,
} from "./token-exchange.js";

// ---------------------------------------------------------------------------
// Helpers — build fake minted JWTs + canned exchange responses (NO network).
// ---------------------------------------------------------------------------

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** A structurally-valid JWS string whose payload the mock verifier decodes. */
function fakeJwt(claims: Record<string, unknown>, kid = "sj-1"): string {
  return `${b64url({ alg: "RS256", kid })}.${b64url(claims)}.sig`;
}

/** The default mock verifier: decode the payload segment, return the claims. */
const decodeVerify = vi.fn(
  async (jwt: string, _jwksUrl: string): Promise<Record<string, unknown>> =>
    JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")),
);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const BASE_URL = "http://sj.local";
const RESOURCE = "http://sj.local/mcp";
const ISSUER = "http://sj.local";
const MACHINE_SUB = "machine_openclaw";
const EXTERNAL_ID = "user_2abcDEF";
const CHANNEL = "telegram";
// The Tier-2 REQUEST subject is channel-scoped: "<channel>:<externalId>" (this is
// the requested_subject on the wire AND the cache key). But SJ RESOLVES it through
// the passcode linkage, so the MINTED token's `sub` is the real Clerk user_id
// (unpredictable a priori), with the channel in a SEPARATE `channel` claim (#2951).
const COMPOSED_SUB = `${CHANNEL}:${EXTERNAL_ID}`;
const RESOLVED_CLERK_ID = "user_resolvedClerk"; // what SJ actually mints as sub (Tier 2)
const USER_JWT = "clerk.live.jwt";
const ACTOR_TOKEN = "gateway.m2m.jwt";

const cfg: TokenExchangeConfig = {
  serverId: "sj",
  baseUrl: BASE_URL,
  exchangePath: "/api/tokens/exchange",
  resource: RESOURCE,
  jwksPath: "/api/mcp/.well-known/jwks.json",
  machineSub: MACHINE_SUB,
  issuer: ISSUER,
};

let nowMs: number;
const now = () => nowMs;
const nowSec = () => Math.floor(nowMs / 1000);

/**
 * Build a minted-token response with sane claims (overridable per-test).
 * Defaults to a Tier-2 SJ mint: `sub` = the RESOLVED Clerk user_id, `channel` =
 * the requested channel, `tier` = 2 (most tests exercise Tier 2). Tier-1 tests
 * override `sub` to the bare externalId and `tier` to 1. `expiresIn` is separate
 * from the `exp` claim so a test can prove the cache TTL is driven by the
 * response field, not the claim.
 */
function mintedResponse(overrides: Record<string, unknown> = {}, expiresIn = 900): Response {
  const iat = nowSec();
  const claims = {
    sub: RESOLVED_CLERK_ID,
    act: { sub: MACHINE_SUB },
    channel: CHANNEL,
    aud: RESOURCE,
    iss: BASE_URL,
    iat,
    exp: iat + 1800,
    tier: 2,
    ...overrides,
  };
  return jsonResponse(200, {
    access_token: fakeJwt(claims),
    issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_type: "Bearer",
    expires_in: expiresIn,
  });
}

function makeClient(opts: {
  fetchFn: typeof fetch;
  getActorToken?: () => Promise<string>;
  verifyMintedToken?: (jwt: string, jwksUrl: string) => Promise<Record<string, unknown>>;
}) {
  return new TokenExchangeClient(cfg, {
    getActorToken: opts.getActorToken ?? (async () => ACTOR_TOKEN),
    fetchFn: opts.fetchFn,
    verifyMintedToken: opts.verifyMintedToken ?? decodeVerify,
    now,
  });
}

/** The (url, init) tuple fetch was called with on call #i. */
function fetchCall(fetchFn: ReturnType<typeof vi.fn>, i = 0): [string, RequestInit] {
  return fetchFn.mock.calls[i] as unknown as [string, RequestInit];
}

/** Parse the form-encoded body handed to fetch on call #i. */
function bodyParams(fetchFn: ReturnType<typeof vi.fn>, i = 0): URLSearchParams {
  return new URLSearchParams(fetchCall(fetchFn, i)[1].body as string);
}

const tier1: ExchangeSubject = { tier: 1, externalId: EXTERNAL_ID, userJwt: USER_JWT };
const tier2: ExchangeSubject = { tier: 2, externalId: EXTERNAL_ID, channel: CHANNEL };

beforeEach(() => {
  nowMs = 1_700_000_000_000;
  decodeVerify.mockClear();
});

// ---------------------------------------------------------------------------
// 1 + 2 — request shapes
// ---------------------------------------------------------------------------

describe("TokenExchangeClient request shape", () => {
  it("Tier 1: form-encoded body carries subject_token (+type) and NO requested_subject", async () => {
    // Tier-1 minted sub is the bare externalId (Clerk-JWT/HTTP path).
    const fetchFn = vi.fn(async () => mintedResponse({ tier: 1, sub: EXTERNAL_ID }));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier1);

    // Endpoint + content type.
    const [url, init] = fetchCall(fetchFn);
    expect(url).toBe(`${BASE_URL}/api/tokens/exchange`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const p = bodyParams(fetchFn);
    expect(p.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(p.get("actor_token")).toBe(ACTOR_TOKEN);
    expect(p.get("actor_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(p.get("resource")).toBe(RESOURCE);
    expect(p.get("subject_token")).toBe(USER_JWT);
    expect(p.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(p.has("requested_subject")).toBe(false);
    // Exact param set (no extras).
    expect([...p.keys()].sort()).toEqual(
      [
        "actor_token",
        "actor_token_type",
        "grant_type",
        "resource",
        "subject_token",
        "subject_token_type",
      ].sort(),
    );
  });

  it("Tier 2: requested_subject is the channel-scoped '<channel>:<externalId>' and NO subject_token", async () => {
    const fetchFn = vi.fn(async () => mintedResponse());
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);

    const p = bodyParams(fetchFn);
    expect(p.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(p.get("actor_token")).toBe(ACTOR_TOKEN);
    expect(p.get("actor_token_type")).toBe("urn:ietf:params:oauth:token-type:jwt");
    expect(p.get("resource")).toBe(RESOURCE);
    // Channel-scoped subject — NOT a bare externalId (impersonation surface removed).
    expect(p.get("requested_subject")).toBe(`${CHANNEL}:${EXTERNAL_ID}`);
    expect(p.get("requested_subject")).toBe("telegram:user_2abcDEF");
    expect(p.has("subject_token")).toBe(false);
    expect(p.has("subject_token_type")).toBe(false);
    expect([...p.keys()].sort()).toEqual(
      ["actor_token", "actor_token_type", "grant_type", "requested_subject", "resource"].sort(),
    );
  });

  it("returns the minted access_token on success", async () => {
    const fetchFn = vi.fn(async () => mintedResponse());
    const client = makeClient({ fetchFn });
    const token = await client.getUserToken(tier2);
    expect(typeof token).toBe("string");
    expect(token.split(".")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3 — validate BEFORE cache
// ---------------------------------------------------------------------------

describe("TokenExchangeClient validate-before-cache", () => {
  it("verifies the minted token against {baseUrl}{jwksPath}", async () => {
    const verify = vi.fn(decodeVerify);
    const fetchFn = vi.fn(async () => mintedResponse());
    const client = makeClient({ fetchFn, verifyMintedToken: verify });
    await client.getUserToken(tier2);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![1]).toBe(`${BASE_URL}/api/mcp/.well-known/jwks.json`);
  });

  // Tier-2 binding integrity: `sub` is NOT bound (SJ resolves it to a Clerk id
  // this client can't predict); the request↔token binding is `channel` + `tier`.
  it.each([
    ["wrong act.sub", { act: { sub: "attacker_machine" } }],
    ["wrong aud", { aud: "http://sj.local/other" }],
    ["wrong channel", { channel: "slack" }],
    ["missing channel", { channel: undefined }],
    ["wrong tier (1)", { tier: 1 }],
    ["empty sub", { sub: "" }],
    ["missing sub", { sub: undefined }],
  ])("rejects a %s claim and caches nothing (Tier 2)", async (_label, override) => {
    const fetchFn = vi.fn(async () => mintedResponse(override));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    // Nothing cached — a second attempt re-hits the exchange.
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("Tier 2 happy path: accepts a RESOLVED Clerk sub (not the composed request subject)", async () => {
    // SJ mints sub=<resolved clerk id> + channel=<requested channel> + tier=2.
    // The client must NOT reject on sub (it can't predict the resolved id); it
    // binds on channel + tier and returns the token, cached under the REQUEST key.
    const fetchFn = vi.fn(async () =>
      mintedResponse({ sub: RESOLVED_CLERK_ID, channel: CHANNEL, tier: 2 }),
    );
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).resolves.toBeTypeOf("string");
    // Cached under the composed REQUEST identity — a second call hits the cache.
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("Tier 1: STILL binds sub === externalId (a mismatched sub is rejected)", async () => {
    // Tier-1 rides the Clerk JWT straight through, so the minted sub IS the
    // externalId — this binding is unchanged.
    const bad = vi.fn(async () => mintedResponse({ tier: 1, sub: "user_someone_else" }));
    await expect(makeClient({ fetchFn: bad }).getUserToken(tier1)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
    const ok = vi.fn(async () => mintedResponse({ tier: 1, sub: EXTERNAL_ID }));
    await expect(makeClient({ fetchFn: ok }).getUserToken(tier1)).resolves.toBeTypeOf("string");
  });

  it("Tier 2 cross-user isolation: A's resolved token is never served for B's request", async () => {
    // Two DIFFERENT external ids on the SAME channel resolve to two DIFFERENT
    // Clerk subs; the cache keys on the REQUEST subject "<channel>:<externalId>",
    // so B never receives A's token.
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const requested = new URLSearchParams(init!.body as string).get("requested_subject")!;
      const iat = nowSec();
      // SJ resolves each composed request to a distinct Clerk id.
      const resolvedSub = requested === "telegram:usr_A" ? "clerk_A" : "clerk_B";
      return jsonResponse(200, {
        access_token: fakeJwt({
          sub: resolvedSub,
          act: { sub: MACHINE_SUB },
          channel: "telegram",
          aud: RESOURCE,
          iss: BASE_URL,
          iat,
          exp: iat + 1800,
          tier: 2,
        }),
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_type: "Bearer",
        expires_in: 900,
      });
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    const a: ExchangeSubject = { tier: 2, externalId: "usr_A", channel: "telegram" };
    const b: ExchangeSubject = { tier: 2, externalId: "usr_B", channel: "telegram" };
    const tokenA = await client.getUserToken(a);
    const tokenB = await client.getUserToken(b);
    expect(tokenA).not.toBe(tokenB); // distinct exchanges, distinct minted subs
    expect(fetchFn).toHaveBeenCalledTimes(2);
    // A re-request hits A's cache (not B's).
    expect(await client.getUserToken(a)).toBe(tokenA);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects an already-expired minted token and caches nothing", async () => {
    const iat = nowSec() - 4000;
    const fetchFn = vi.fn(async () => mintedResponse({ iat, exp: iat + 1800 }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects when the signature verify seam throws (never caches)", async () => {
    const fetchFn = vi.fn(async () => mintedResponse());
    const verify = vi.fn(async () => {
      throw new Error("bad signature");
    });
    const client = makeClient({ fetchFn, verifyMintedToken: verify });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tier binding — EXACT types against SJ's verbatim mint payload (#2951)
//   Tier-2: {sub:"user_2xyz", act:{sub}, aud, iss, iat, exp, jti, tier:2, channel:"whatsapp"}
//   Tier-1: {sub:"user_1abc", act:{sub}, aud, iss, iat, exp, jti, tier:1}  ← NO channel
//   `tier` is a JSON NUMBER; `channel` is a top-level string (bare channel).
// ---------------------------------------------------------------------------

describe("TokenExchangeClient tier binding — exact types (SJ verbatim)", () => {
  const waSubject: ExchangeSubject = { tier: 2, externalId: "usr_2abc", channel: "whatsapp" };

  it("Tier-2 verbatim: tier:2 (number) + top-level channel:'whatsapp' + resolved sub → ACCEPTED", async () => {
    const fetchFn = vi.fn(async () =>
      mintedResponse({
        sub: "user_2xyz", // bare resolved Clerk id — NOT the composed request
        channel: "whatsapp", // top-level string, VALUE is the bare channel
        tier: 2, // JSON number
        jti: "jti_abc123", // present in the real mint; ignored by the client
      }),
    );
    await expect(makeClient({ fetchFn }).getUserToken(waSubject)).resolves.toBeTypeOf("string");
  });

  it("Tier-2: tier as the STRING '2' → REJECTED (number-type binding)", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ channel: "whatsapp", tier: "2" }));
    await expect(makeClient({ fetchFn }).getUserToken(waSubject)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });

  it("Tier-2: tier:1 for a Tier-2 request → REJECTED (tier confusion)", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ channel: "whatsapp", tier: 1 }));
    await expect(makeClient({ fetchFn }).getUserToken(waSubject)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });

  it("Tier-1 verbatim: tier:1 (number) + NO channel key → ACCEPTED", async () => {
    // channel:undefined drops the key from the JSON payload (matches the real
    // Tier-1 mint, which carries no channel claim).
    const fetchFn = vi.fn(async () =>
      mintedResponse({ tier: 1, sub: EXTERNAL_ID, channel: undefined, jti: "jti_t1" }),
    );
    await expect(makeClient({ fetchFn }).getUserToken(tier1)).resolves.toBeTypeOf("string");
  });

  it("Tier-1: tier as the STRING '1' → REJECTED (number-type binding)", async () => {
    const fetchFn = vi.fn(async () =>
      mintedResponse({ tier: "1", sub: EXTERNAL_ID, channel: undefined }),
    );
    await expect(makeClient({ fetchFn }).getUserToken(tier1)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });

  it("Tier-1: tier:2 for a Tier-1 request → REJECTED (tier===1 defense)", async () => {
    const fetchFn = vi.fn(async () =>
      mintedResponse({ tier: 2, sub: EXTERNAL_ID, channel: undefined }),
    );
    await expect(makeClient({ fetchFn }).getUserToken(tier1)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });
});

// ---------------------------------------------------------------------------
// 3b — iss + nbf claim checks (devex condition-of-approval)
// ---------------------------------------------------------------------------

describe("TokenExchangeClient iss + nbf validation", () => {
  it("rejects a wrong issuer and caches nothing", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ iss: "http://evil.example/mcp" }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing issuer and caches nothing", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ iss: undefined }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("tolerates an issuer differing only by a trailing slash", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ iss: `${ISSUER}/` }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).resolves.toBeTypeOf("string");
  });

  it("rejects a not-yet-valid token (nbf in the future) and caches nothing", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ nbf: nowSec() + 120 }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("accepts a token whose nbf is in the past", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ nbf: nowSec() - 120 }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).resolves.toBeTypeOf("string");
  });

  it("accepts a token with no nbf claim", async () => {
    const fetchFn = vi.fn(async () => mintedResponse()); // no nbf
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).resolves.toBeTypeOf("string");
  });
});

// ---------------------------------------------------------------------------
// 4 + 5 — cache hit / expiry
// ---------------------------------------------------------------------------

describe("TokenExchangeClient caching", () => {
  it("returns the cached token within TTL without a second fetch", async () => {
    const fetchFn = vi.fn(async () => mintedResponse());
    const client = makeClient({ fetchFn });
    const a = await client.getUserToken(tier2);
    const b = await client.getUserToken(tier2);
    expect(a).toBe(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("re-exchanges once now passes (expires_in − 60s skew)", async () => {
    // expires_in:900 (SJ ≤15min) drives the TTL; skew is 60s.
    const fetchFn = vi.fn(async () => mintedResponse({}, 900));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Still fresh just before the skew boundary (900 − 60 = 840s).
    nowMs += (900 - 61) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Cross the skew boundary — must re-exchange.
    nowMs += 2 * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caches per subject key (distinct channel-scoped subjects do not share a token)", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const requested = new URLSearchParams(init!.body as string).get("requested_subject")!;
      const channel = requested.split(":")[0]!; // SJ echoes the requested channel
      const iat = nowSec();
      return jsonResponse(200, {
        access_token: fakeJwt({
          sub: `clerk_${requested}`, // resolved Clerk id (not the composed request)
          act: { sub: MACHINE_SUB },
          channel,
          aud: RESOURCE,
          iss: BASE_URL,
          iat,
          exp: iat + 1800,
          tier: 2,
        }),
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_type: "Bearer",
        expires_in: 900,
      });
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await client.getUserToken({ tier: 2, externalId: "userX", channel: "telegram" });
    await client.getUserToken({ tier: 2, externalId: "userX", channel: "whatsapp" }); // diff channel
    await client.getUserToken({ tier: 2, externalId: "userX", channel: "telegram" }); // cached
    // Same externalId on two channels are DISTINCT subjects → two fetches, third cached.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("caches TTL driven by the response expires_in field (not the exp claim / a constant)", async () => {
    // exp claim deliberately says +1800 but expires_in says 900 → TTL must follow 900.
    const iat0 = nowSec();
    const fetchFn = vi.fn(async () => mintedResponse({ iat: iat0, exp: iat0 + 1800 }, 900));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    // Advance past 900−60 but well within the 1800 claim — proves 900 drove it.
    nowMs += (900 - 59) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("a longer expires_in (1800) yields a correspondingly longer cache TTL", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({}, 1800));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    // At 900−59 (which re-exchanged the 900s token) the 1800s token is still fresh.
    nowMs += (900 - 59) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // Cross the 1800−60 boundary → re-exchange.
    nowMs += (1800 - 900) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 6 — single-flight
// ---------------------------------------------------------------------------

describe("TokenExchangeClient single-flight", () => {
  it("collapses concurrent getUserToken for one externalId into ONE fetch", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchFn = vi.fn(() => gate);
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });

    const p1 = client.getUserToken(tier2);
    const p2 = client.getUserToken(tier2);
    // Let the getActorToken microtask settle so the (single) fetch is dispatched.
    await new Promise((r) => setImmediate(r));
    expect(fetchFn).toHaveBeenCalledTimes(1);

    release(mintedResponse());
    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe(t2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7 — invalidate
// ---------------------------------------------------------------------------

describe("TokenExchangeClient invalidate", () => {
  it("drops the cache (keyed by the composed subjectId) so the next call re-exchanges", async () => {
    const fetchFn = vi.fn(async () => mintedResponse());
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // The cache key is the composed subjectId (channel-scoped) — invalidate on it.
    client.invalidate(subjectId(tier2));
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("invalidate of one subject leaves another's cache intact", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const requested = new URLSearchParams(init!.body as string).get("requested_subject")!;
      const channel = requested.split(":")[0]!;
      const iat = nowSec();
      return jsonResponse(200, {
        access_token: fakeJwt({
          sub: `clerk_${requested}`,
          act: { sub: MACHINE_SUB },
          channel,
          aud: RESOURCE,
          iss: BASE_URL,
          iat,
          exp: iat + 1800,
          tier: 2,
        }),
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_type: "Bearer",
        expires_in: 900,
      });
    });
    const a: ExchangeSubject = { tier: 2, externalId: "user_a", channel: "telegram" };
    const b: ExchangeSubject = { tier: 2, externalId: "user_b", channel: "telegram" };
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await client.getUserToken(a);
    await client.getUserToken(b);
    client.invalidate(subjectId(a));
    await client.getUserToken(b); // still cached
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await client.getUserToken(a); // re-exchange
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 8 + 9 — error mapping + token/PII hygiene
// ---------------------------------------------------------------------------

describe("TokenExchangeClient error mapping + hygiene", () => {
  it.each([
    [400, "invalid_grant"],
    [401, "invalid_request"],
    [429, "unauthorized_client"],
  ])("maps a %s error response to a structured error (no token)", async (status, errCode) => {
    const fetchFn = vi.fn(async () => jsonResponse(status, { error: errCode }));
    const client = makeClient({ fetchFn });
    let thrown: unknown;
    try {
      await client.getUserToken(tier1);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TokenExchangeError);
    const msg = (thrown as Error).message;
    expect(msg).not.toContain(ACTOR_TOKEN);
    expect(msg).not.toContain(USER_JWT);
    expect(msg).not.toContain(EXTERNAL_ID);
  });

  it("maps a network failure to a structured error (no secrets leaked)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED ${ACTOR_TOKEN}`);
    });
    const client = makeClient({ fetchFn });
    let thrown: unknown;
    try {
      await client.getUserToken(tier1);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TokenExchangeError);
    expect((thrown as Error).message).not.toContain(ACTOR_TOKEN);
  });

  it("never leaks access_token / actor_token / subject_token / externalId in a claim-mismatch error", async () => {
    const secretAccess = fakeJwt({
      sub: "user_someone_else",
      act: { sub: MACHINE_SUB },
      aud: RESOURCE,
      iat: nowSec(),
      exp: nowSec() + 1800,
    });
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        access_token: secretAccess,
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_type: "Bearer",
        expires_in: 1800,
      }),
    );
    const client = makeClient({ fetchFn });
    let thrown: unknown;
    try {
      await client.getUserToken(tier1);
    } catch (e) {
      thrown = e;
    }
    const msg = (thrown as Error).message;
    expect(msg).not.toContain(secretAccess);
    expect(msg).not.toContain(ACTOR_TOKEN);
    expect(msg).not.toContain(USER_JWT);
    expect(msg).not.toContain(EXTERNAL_ID);
  });

  it("surfaces a structured error (no token) when getActorToken fails", async () => {
    const fetchFn = vi.fn(async () => mintedResponse());
    const client = makeClient({
      fetchFn,
      getActorToken: async () => {
        throw new Error("service-auth: secret missing");
      },
    });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createJwksVerifier — the DEFAULT signature/JWKS kernel (devex conditions)
// ---------------------------------------------------------------------------

// One RSA keypair for the whole suite; the public JWK (with kid) is served via
// the injectable fetchJwks so no network is touched.
const { privateKey: RSA_PRIV, publicKey: RSA_PUB } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const SIGNING_JWK: JsonWebKey & { kid: string } = {
  ...(RSA_PUB.export({ format: "jwk" }) as JsonWebKey),
  kid: "sj-1",
};

const JWKS_URL = "http://sj.local/api/mcp/.well-known/jwks.json";

/** Sign an RS256 JWT with the suite keypair (real signature). */
function signRs256(claims: Record<string, unknown>, kid = "sj-1"): string {
  const header = b64url({ alg: "RS256", kid });
  const payload = b64url(claims);
  const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(RSA_PRIV);
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

/** A non-RS256 token with three non-empty segments (reaches the alg check). */
function fakeAlgToken(alg: string): string {
  return `${b64url({ alg, kid: "sj-1" })}.${b64url({ sub: "x" })}.c2ln`;
}

const sampleClaims = () => ({ sub: EXTERNAL_ID, aud: RESOURCE, iss: ISSUER, iat: nowSec() });

describe("createJwksVerifier alg hard-pin (algorithm-confusion)", () => {
  it("rejects alg=none BEFORE any JWKS fetch/key work", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await expect(verify(fakeAlgToken("none"), JWKS_URL)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchJwks).not.toHaveBeenCalled();
  });

  it("rejects alg=HS256 (HMAC over the JWKS public key) BEFORE any JWKS fetch/key work", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await expect(verify(fakeAlgToken("HS256"), JWKS_URL)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
    expect(fetchJwks).not.toHaveBeenCalled();
  });
});

describe("createJwksVerifier JWKS caching + unknown-kid fail-closed", () => {
  it("verifies a valid RS256 token and returns its claims", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    const claims = await verify(signRs256(sampleClaims()), JWKS_URL);
    expect(claims.sub).toBe(EXTERNAL_ID);
  });

  it("fetches the JWKS ONCE across two verifies within the 300s max-age (cache hit)", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await verify(signRs256(sampleClaims()), JWKS_URL);
    nowMs += 299 * 1000; // still inside 300s
    await verify(signRs256(sampleClaims()), JWKS_URL);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("refetches the JWKS after the 300s max-age expires", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await verify(signRs256(sampleClaims()), JWKS_URL);
    nowMs += 301 * 1000; // past 300s
    await verify(signRs256(sampleClaims()), JWKS_URL);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("FAILS CLOSED on an unknown kid — NO extra fetch-and-trust refetch", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] })); // only sj-1
    const verify = createJwksVerifier({ fetchJwks, now });
    // Token signed with a kid absent from the cached set.
    await expect(verify(signRs256(sampleClaims(), "sj-99"), JWKS_URL)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
    // Exactly one fetch (to populate) — NO second cache-bypassing refetch.
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the JWKS fetch errors (no token accepted)", async () => {
    const fetchJwks = vi.fn(async () => {
      throw new Error("JWKS 503");
    });
    const verify = createJwksVerifier({ fetchJwks, now });
    await expect(verify(signRs256(sampleClaims()), JWKS_URL)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });

  it("rejects a token whose signature does not match the JWKS key", async () => {
    // Sign with a DIFFERENT key than the one served by fetchJwks.
    const { privateKey: otherPriv } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = b64url({ alg: "RS256", kid: "sj-1" });
    const payload = b64url(sampleClaims());
    const badSig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(otherPriv);
    const forged = `${header}.${payload}.${badSig.toString("base64url")}`;
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await expect(verify(forged, JWKS_URL)).rejects.toBeInstanceOf(TokenExchangeError);
  });
});

// ---------------------------------------------------------------------------
// QG hardening — DESIGN-GENGUARD, SEC-EXPCLAMP, decode-guard, empty-JWKS,
// jwks-singleflight, cache-evict, exp/expires_in branches, aud-array, no-kid.
// ---------------------------------------------------------------------------

/** Sign an RS256 JWT over an ARBITRARY (already-encoded) payload segment. */
function signRaw(headerObj: Record<string, unknown>, payloadB64: string): string {
  const header = b64url(headerObj);
  const sig = createSign("RSA-SHA256").update(`${header}.${payloadB64}`).sign(RSA_PRIV);
  return `${header}.${payloadB64}.${sig.toString("base64url")}`;
}

describe("TokenExchangeClient DESIGN-GENGUARD (invalidate races an in-flight exchange)", () => {
  it("does NOT cache a token whose exchange resolves AFTER an invalidate()", async () => {
    let release!: (r: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchFn = vi.fn(() => {
      calls += 1;
      return calls === 1 ? gate : Promise.resolve(mintedResponse());
    });
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });

    const p1 = client.getUserToken(tier2); // in flight, gated
    await new Promise((r) => setImmediate(r));
    client.invalidate(subjectId(tier2)); // bump generation mid-flight
    release(mintedResponse());
    await p1; // resolves, but must NOT populate the cache (stale generation)

    // Next call sees an empty cache → a SECOND exchange.
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("TokenExchangeClient SEC-EXPCLAMP (never trust expires_in past exp)", () => {
  it("clamps the cache TTL to the signed exp when expires_in overshoots it", async () => {
    // Signed exp is at now+900; the (untrusted) expires_in claims 100000s.
    const iat = nowSec();
    const fetchFn = vi.fn(async () => mintedResponse({ iat, exp: iat + 900 }, 100_000));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Just past exp−skew (900−60) → must re-exchange (NOT held for +100000s).
    nowMs += (900 - 59) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("uses expires_in when it is shorter than exp (min of the two)", async () => {
    const iat = nowSec();
    const fetchFn = vi.fn(async () => mintedResponse({ iat, exp: iat + 100_000 }, 900));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    nowMs += (900 - 59) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("TokenExchangeClient CODE-CACHE-EVICT (sweepExpired)", () => {
  it("removes expired entries and keeps live ones", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      const requested = new URLSearchParams(init!.body as string).get("requested_subject")!;
      const channel = requested.split(":")[0]!;
      const iat = nowSec();
      return jsonResponse(200, {
        access_token: fakeJwt({
          sub: `clerk_${requested}`,
          act: { sub: MACHINE_SUB },
          channel,
          aud: RESOURCE,
          iss: BASE_URL,
          iat,
          exp: iat + 1800,
          tier: 2,
        }),
        issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_type: "Bearer",
        expires_in: 900,
      });
    });
    const shortLived: ExchangeSubject = { tier: 2, externalId: "u_short", channel: "telegram" };
    const client = makeClient({ fetchFn: fetchFn as unknown as typeof fetch });
    await client.getUserToken(shortLived); // TTL ~900s
    // A live entry minted later with a much longer clock offset stays cached.
    nowMs += 1000 * 1000; // shortLived is now expired (900s < 1000s)
    const longLived: ExchangeSubject = { tier: 2, externalId: "u_long", channel: "telegram" };
    await client.getUserToken(longLived);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    client.sweepExpired(); // evicts u_short (expired), keeps u_long

    await client.getUserToken(longLived); // still cached → no fetch
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await client.getUserToken(shortLived); // evicted → re-exchange
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("TokenExchangeClient exp / expires_in branches", () => {
  it("rejects a missing exp claim (uncached)", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ exp: undefined }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-number exp claim (uncached)", async () => {
    const fetchFn = vi.fn(async () => mintedResponse({ exp: "later" }));
    const client = makeClient({ fetchFn });
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["absent", undefined],
    ["zero", 0],
    ["negative", -5],
  ])("falls back to the exp claim TTL when expires_in is %s", async (_label, expiresIn) => {
    const iat = nowSec();
    const fetchFn = vi.fn(async () => mintedResponse({ iat, exp: iat + 900 }, expiresIn as number));
    const client = makeClient({ fetchFn });
    await client.getUserToken(tier2);
    // Cache tracks exp−skew (900−60): still fresh just before, re-exchange after.
    nowMs += (900 - 61) * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    nowMs += 2 * 1000;
    await client.getUserToken(tier2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("TokenExchangeClient aud as an array", () => {
  it("accepts aud:[resource] and rejects aud:[other]", async () => {
    const ok = vi.fn(async () => mintedResponse({ aud: [RESOURCE] }));
    await expect(makeClient({ fetchFn: ok }).getUserToken(tier2)).resolves.toBeTypeOf("string");
    const bad = vi.fn(async () => mintedResponse({ aud: ["http://sj.local/other"] }));
    await expect(makeClient({ fetchFn: bad }).getUserToken(tier2)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });
});

describe("TokenExchangeClient TEST-SINGLEFLIGHT-FAIL", () => {
  it("two concurrent exchanges that reject → both reject, ONE fetch, inFlight cleared", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return jsonResponse(400, { error: "invalid_grant" });
    });
    const client = makeClient({ fetchFn });
    const [r1, r2] = await Promise.allSettled([
      client.getUserToken(tier2),
      client.getUserToken(tier2),
    ]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    expect(calls).toBe(1); // single-flighted
    // inFlight cleared → a subsequent call re-exchanges.
    await expect(client.getUserToken(tier2)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(calls).toBe(2);
  });
});

describe("createJwksVerifier CODE-DECODE-GUARD", () => {
  it.each([
    ["null", "null"],
    ["array", JSON.stringify([1, 2])],
    ["primitive", JSON.stringify(42)],
  ])("rejects a token whose payload decodes to %s with a structured error", async (_l, json) => {
    const payloadB64 = Buffer.from(json, "utf8").toString("base64url");
    const token = signRaw({ alg: "RS256", kid: "sj-1" }, payloadB64);
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await expect(verify(token, JWKS_URL)).rejects.toBeInstanceOf(TokenExchangeError);
  });
});

describe("createJwksVerifier SEC-EMPTY-JWKS", () => {
  it("does NOT cache an empty keyset — the next verify refetches", async () => {
    let first = true;
    const fetchJwks = vi.fn(async () => {
      if (first) {
        first = false;
        return { keys: [] as JsonWebKey[] };
      }
      return { keys: [SIGNING_JWK] };
    });
    const verify = createJwksVerifier({ fetchJwks, now });
    // First verify: empty keyset → unknown-kid reject, NOT cached.
    await expect(verify(signRs256(sampleClaims()), JWKS_URL)).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
    // Second verify (same 300s window): refetches (empty was not cached) → OK.
    await expect(verify(signRs256(sampleClaims()), JWKS_URL)).resolves.toBeTypeOf("object");
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });
});

describe("createJwksVerifier CODE-JWKS-SINGLEFLIGHT", () => {
  it("two concurrent cold verifies share ONE JWKS fetch", async () => {
    let release!: (v: { keys: JsonWebKey[] }) => void;
    const gate = new Promise<{ keys: JsonWebKey[] }>((resolve) => {
      release = resolve;
    });
    const fetchJwks = vi.fn(() => gate);
    const verify = createJwksVerifier({ fetchJwks, now });
    const p1 = verify(signRs256(sampleClaims()), JWKS_URL);
    const p2 = verify(signRs256(sampleClaims()), JWKS_URL);
    await new Promise((r) => setImmediate(r));
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    release({ keys: [SIGNING_JWK] });
    await Promise.all([p1, p2]);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });
});

describe("createJwksVerifier TEST-NOKID", () => {
  it.each([
    ["missing", {}],
    ["empty", { kid: "" }],
  ])("rejects an RS256 header with a %s kid BEFORE any JWKS fetch", async (_l, kidPart) => {
    const payloadB64 = b64url(sampleClaims());
    const token = signRaw({ alg: "RS256", ...kidPart }, payloadB64);
    const fetchJwks = vi.fn(async () => ({ keys: [SIGNING_JWK] }));
    const verify = createJwksVerifier({ fetchJwks, now });
    await expect(verify(token, JWKS_URL)).rejects.toBeInstanceOf(TokenExchangeError);
    expect(fetchJwks).not.toHaveBeenCalled();
  });
});
