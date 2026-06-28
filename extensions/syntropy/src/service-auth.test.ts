/**
 * Unit tests for the openclaw → SJ /mcp service-auth token provider (P2 T2.2).
 *
 * Requirements covered (from the task + P2 wire contract, AND.md §"P2"):
 *  - The minted M2M JWT carries `resource` == the configured SJ /mcp URI, is
 *    RS256-signed, and has a verifiable `sub` (machine id). We mint a real RS256
 *    fixture from Node `crypto` and verify it, mirroring what SJ does via JWKS.
 *  - The mint request is faithful to `createToken({tokenFormat:'jwt',
 *    claims:{resource}})` — token_format=jwt, claims.resource, machine secret as
 *    Bearer to POST /v1/m2m_tokens.
 *  - Missing machine secret => fail-closed (getToken throws; no request emitted).
 *  - Token is cached and refreshed before `exp` (refresh-skew honored).
 *  - The Bearer is attached to the SJ /mcp request path (header builder + the
 *    callMcpToolWithServiceAuth seam in client.ts).
 */

import { generateKeyPairSync, createSign, createVerify } from "node:crypto";
import { describe, test, expect, vi } from "vitest";
import { callMcpToolWithServiceAuth } from "./client.js";
import type { ServiceAuthConfig } from "./service-auth-config.js";
import {
  ServiceAuthProvider,
  clerkBapiMint,
  withServiceAuthBearer,
  DEFAULT_TOKEN_TTL_SECONDS,
  type MintFn,
} from "./service-auth.js";

const SJ_MCP = "https://shrine-api-test.up.railway.app/mcp";
const MACHINE_SUB = "mch_2abcOpenclawMachineId";

// ---------------------------------------------------------------------------
// RS256 JWT fixture — mimics a Clerk-minted M2M JWT (Clerk signs server-side;
// here we sign locally only to assert the provider carries claims through and
// that an SJ-style RS256+sub+resource verification passes).
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signRs256Jwt(claims: Record<string, unknown>): string {
  const header = { alg: "RS256", typ: "JWT", kid: "ins_test_kid" };
  const headerPart = b64url(JSON.stringify(header));
  const payloadPart = b64url(JSON.stringify(claims));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const [h, p] = token.split(".");
  const dec = (s: string) =>
    JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { header: dec(h), payload: dec(p) };
}

/** SJ-style verification: RS256 signature valid AND sub present. */
function verifyRs256(token: string): boolean {
  const [h, p, s] = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  verifier.end();
  const sig = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return verifier.verify(publicKey, sig);
}

function makeJwt(resource: string, expSeconds: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return signRs256Jwt({
    sub: MACHINE_SUB,
    iss: "https://clerk.example.com",
    iat: nowSec,
    nbf: nowSec,
    exp: expSeconds,
    resource,
  });
}

function cfg(overrides: Partial<ServiceAuthConfig> = {}): ServiceAuthConfig {
  return {
    machineSecretKey: "ak_test_secret",
    resource: SJ_MCP,
    clerkApiUrl: "https://api.clerk.com",
    isProduction: false,
    ...overrides,
  };
}

describe("ServiceAuthProvider — minted token shape", () => {
  test("getToken returns an RS256 JWT carrying resource == configured URI and a verifiable sub", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const mint: MintFn = async (c) => ({
      token: makeJwt(c.resource, expSec),
      expiresAtMs: expSec * 1000,
    });
    const provider = new ServiceAuthProvider(cfg(), { mint });

    const token = await provider.getToken();
    const { header, payload } = decodeJwt(token);

    // RS256 pinned (the alg/none + HS256-confusion defenses live SJ-side, but
    // the token openclaw mints must be RS256).
    expect(header.alg).toBe("RS256");
    // resource claim == configured SJ /mcp URI, exactly.
    expect(payload.resource).toBe(SJ_MCP);
    // verifiable sub (machine id).
    expect(payload.sub).toBe(MACHINE_SUB);
    // RS256 signature verifies against the public key (SJ does this via JWKS).
    expect(verifyRs256(token)).toBe(true);
  });
});

describe("ServiceAuthProvider — fail-closed on missing secret", () => {
  test("getToken throws when machine secret absent (production) and never mints", async () => {
    const mint = vi.fn<MintFn>();
    const provider = new ServiceAuthProvider(
      cfg({ machineSecretKey: undefined, isProduction: true }),
      { mint },
    );
    expect(provider.secretMissing).toBe(true);
    await expect(provider.getToken()).rejects.toThrow(/CLERK_MACHINE_SECRET_KEY is missing/);
    expect(mint).not.toHaveBeenCalled();
  });

  test("getToken throws fail-closed in non-production too (no anonymous fallback)", async () => {
    const mint = vi.fn<MintFn>();
    const provider = new ServiceAuthProvider(
      cfg({ machineSecretKey: undefined, isProduction: false }),
      { mint },
    );
    await expect(provider.getToken()).rejects.toThrow(/fail-closed/);
    expect(mint).not.toHaveBeenCalled();
  });
});

describe("ServiceAuthProvider — caching & refresh before expiry", () => {
  test("caches the token across calls (mints once while fresh)", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const mint = vi.fn<MintFn>(async (c) => ({
      token: makeJwt(c.resource, expSec),
      expiresAtMs: expSec * 1000,
    }));
    const provider = new ServiceAuthProvider(cfg(), { mint });

    const a = await provider.getToken();
    const b = await provider.getToken();
    expect(a).toBe(b);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  test("re-mints when within the refresh-skew window of exp", async () => {
    let nowMs = 1_000_000_000_000;
    const now = () => nowMs;
    let mintCount = 0;
    const mint: MintFn = async (c) => {
      mintCount += 1;
      // Each mint expires 100s from "now".
      const expMs = nowMs + 100_000;
      return { token: makeJwt(c.resource, Math.floor(expMs / 1000)), expiresAtMs: expMs };
    };
    const provider = new ServiceAuthProvider(cfg(), {
      mint,
      now,
      refreshSkewSeconds: 60,
    });

    const t1 = await provider.getToken();
    expect(mintCount).toBe(1);

    // Advance 30s — still outside the 60s skew window => cached.
    nowMs += 30_000;
    const t2 = await provider.getToken();
    expect(t2).toBe(t1);
    expect(mintCount).toBe(1);

    // Advance another 20s (now 50s in, 50s left < 60s skew) => refresh.
    nowMs += 20_000;
    const t3 = await provider.getToken();
    expect(mintCount).toBe(2);
    expect(t3).not.toBe(t1);
  });

  test("single-flights concurrent mints (one in-flight mint shared)", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    let mintCount = 0;
    const mint: MintFn = async (c) => {
      mintCount += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { token: makeJwt(c.resource, expSec), expiresAtMs: expSec * 1000 };
    };
    const provider = new ServiceAuthProvider(cfg(), { mint });

    const [a, b, c] = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(mintCount).toBe(1);
  });

  test("invalidate() forces a re-mint on next getToken (even while the cache is fresh)", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    let n = 0;
    const mint = vi.fn<MintFn>(async (c) => ({
      token: `${makeJwt(c.resource, expSec)}#${n++}`,
      expiresAtMs: expSec * 1000,
    }));
    const provider = new ServiceAuthProvider(cfg(), { mint });
    const first = await provider.getToken();
    provider.invalidate();
    const second = await provider.getToken();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
  });

  test("F1: invalidate() during an in-flight mint does not let the stale mint repopulate the cache", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    let mintCount = 0;
    let releaseFirst: (() => void) | undefined;
    const mint: MintFn = async (c) => {
      mintCount += 1;
      if (mintCount === 1) {
        // First (stale) mint: block until we release it AFTER invalidate().
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
        return { token: `STALE#${makeJwt(c.resource, expSec)}`, expiresAtMs: expSec * 1000 };
      }
      return { token: `FRESH#${makeJwt(c.resource, expSec)}`, expiresAtMs: expSec * 1000 };
    };
    const provider = new ServiceAuthProvider(cfg(), { mint });

    // Kick off the first mint (in flight, blocked).
    const p1 = provider.getToken();
    // Let the mint dispatch.
    await new Promise((r) => setTimeout(r, 1));
    // A 401 elsewhere triggers invalidate() while mint #1 is still in flight.
    provider.invalidate();
    // Release the stale mint; its awaiter (p1) still gets its value...
    releaseFirst?.();
    const stale = await p1;
    expect(stale).toContain("STALE");

    // ...but the NEXT getToken must NOT serve the stale token — it must re-mint.
    const fresh = await provider.getToken();
    expect(fresh).toContain("FRESH");
    expect(mintCount).toBe(2);
  });

  test("F5: a rejected mint propagates to all awaiters and the next getToken retries (not wedged)", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    let mintCount = 0;
    const mint: MintFn = async (c) => {
      mintCount += 1;
      if (mintCount === 1) throw new Error("transient Clerk 503");
      return { token: makeJwt(c.resource, expSec), expiresAtMs: expSec * 1000 };
    };
    const provider = new ServiceAuthProvider(cfg(), { mint });

    // Two concurrent callers share the one (rejecting) in-flight mint.
    const [r1, r2] = await Promise.allSettled([provider.getToken(), provider.getToken()]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    expect(mintCount).toBe(1);

    // The rejected mint must NOT be cached — a subsequent call retries + succeeds.
    const ok = await provider.getToken();
    expect(typeof ok).toBe("string");
    expect(mintCount).toBe(2);
  });
});

describe("clerkBapiMint — faithful createToken request", () => {
  test("POSTs token_format=jwt + claims.resource with machine secret as Bearer", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const captured: { url?: string; init?: RequestInit } = {};
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(
        JSON.stringify({
          token: makeJwt(SJ_MCP, expSec),
          expiration: expSec,
          subject: MACHINE_SUB,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const minted = await clerkBapiMint(cfg());

      expect(captured.url).toBe("https://api.clerk.com/v1/m2m_tokens");
      expect(captured.init?.method).toBe("POST");
      const headers = captured.init?.headers as Record<string, string>;
      // Machine secret is the Bearer credential for the mint call.
      expect(headers.Authorization).toBe("Bearer ak_test_secret");
      const body = JSON.parse(String(captured.init?.body));
      expect(body.token_format).toBe("jwt");
      expect(body.claims).toEqual({ resource: SJ_MCP });
      expect(typeof body.seconds_until_expiration).toBe("number");

      // expiration (unix seconds) is converted to epoch ms.
      expect(minted.expiresAtMs).toBe(expSec * 1000);
      expect(decodeJwt(minted.token).payload.resource).toBe(SJ_MCP);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("forwards Clerk's token string byte-for-byte (pass-through fidelity)", async () => {
    // F4: openclaw's actual responsibility is to forward Clerk's opaque token
    // unchanged — NOT to sign or re-encode it. Assert exact equality.
    const opaque = "eyJOPAQUE.CLERK.TOKEN_string-not-built-by-us_123";
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: opaque, expiration: expSec }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const minted = await clerkBapiMint(cfg());
      expect(minted.token).toBe(opaque);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("non-2xx mint surfaces an error without leaking the secret", async () => {
    expect.assertions(2);
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(clerkBapiMint(cfg())).rejects.toThrow(/Clerk mint failed \(401\)/);
      // The thrown message must not contain the machine secret.
      await expect(clerkBapiMint(cfg())).rejects.toThrow(
        expect.not.stringContaining("ak_test_secret"),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("mint with no token in response throws", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ expiration: 123 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(clerkBapiMint(cfg())).rejects.toThrow(/returned no token/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("F3: absent expiration falls back to ~DEFAULT_TOKEN_TTL_SECONDS from now", async () => {
    const before = Date.now();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: makeJwt(SJ_MCP, 0) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const minted = await clerkBapiMint(cfg());
      const expectedFloor = before + DEFAULT_TOKEN_TTL_SECONDS * 1000;
      // Within a generous window of the requested TTL — never in the past.
      expect(minted.expiresAtMs).toBeGreaterThanOrEqual(expectedFloor - 1000);
      expect(minted.expiresAtMs).toBeLessThanOrEqual(
        Date.now() + DEFAULT_TOKEN_TTL_SECONDS * 1000 + 1000,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("F3: an already-past expiration is clamped to the TTL fallback (no permanent re-mint)", async () => {
    const pastSec = Math.floor(Date.now() / 1000) - 10_000;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ token: makeJwt(SJ_MCP, pastSec), expiration: pastSec }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const minted = await clerkBapiMint(cfg());
      // Must be in the future, not the (rejected) past timestamp.
      expect(minted.expiresAtMs).toBeGreaterThan(Date.now());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Bearer attached to the SJ /mcp request path", () => {
  test("buildAuthHeaders / withServiceAuthBearer attach Authorization: Bearer <token>", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt(SJ_MCP, expSec);
    const mint: MintFn = async () => ({ token, expiresAtMs: expSec * 1000 });
    const provider = new ServiceAuthProvider(cfg(), { mint });

    const headers = await provider.buildAuthHeaders({ "Content-Type": "application/json" });
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const viaHelper = await withServiceAuthBearer(provider);
    expect(viaHelper.Authorization).toBe(`Bearer ${token}`);
  });

  test("callMcpToolWithServiceAuth sends the M2M Bearer + correct JSON-RPC envelope to <baseUrl>/mcp", async () => {
    const expSec = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt(SJ_MCP, expSec);
    const provider = { getToken: async () => token };

    const captured: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.auth = (init.headers as Record<string, string>).Authorization;
      captured.body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: '{"ok":true}' }] } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await callMcpToolWithServiceAuth(
        "https://shrine-api-test.up.railway.app",
        provider,
        "get_health_profile",
        { foo: "bar" },
        { label: "Syntropy" },
      );
      expect(captured.url).toBe("https://shrine-api-test.up.railway.app/mcp");
      expect(captured.auth).toBe(`Bearer ${token}`);
      // F6: assert the JSON-RPC envelope, not just URL + auth.
      expect(captured.body?.jsonrpc).toBe("2.0");
      expect(captured.body?.method).toBe("tools/call");
      expect(captured.body?.params).toEqual({
        name: "get_health_profile",
        arguments: { foo: "bar" },
      });
      expect(res.ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("callMcpToolWithServiceAuth fails closed (no request) when provider throws", async () => {
    const provider = {
      getToken: async () => {
        throw new Error("CLERK_MACHINE_SECRET_KEY is missing (production) — fail-closed");
      },
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await callMcpToolWithServiceAuth(
        "https://x",
        provider,
        "get_health_profile",
        {},
        {
          label: "Syntropy",
        },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/service-auth failed/);
      // Fail-closed: no outbound /mcp request was made.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("callMcpToolWithServiceAuth end-to-end fail-closed with a real provider missing the secret", async () => {
    // Composition test (F5/F8 adjacent): a real ServiceAuthProvider with no
    // machine secret, passed through the seam, must yield no request.
    const provider = new ServiceAuthProvider(
      cfg({ machineSecretKey: undefined, isProduction: true }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await callMcpToolWithServiceAuth(
        "https://shrine-api-test.up.railway.app",
        provider,
        "get_health_profile",
        {},
        { label: "Syntropy" },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/service-auth failed/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
