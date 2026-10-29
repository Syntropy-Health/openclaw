/**
 * JWKS refetch bounds on the network path. A token whose `kid` is not in the cached
 * key set forces one cache-bypassing JWKS fetch. That refetch is single-flight per
 * JWKS URL and runs at most once per JWKS_REFRESH_COOLDOWN_MS; an unknown kid inside
 * the cooldown is rejected without a fetch. After a failed fetch, new fetches wait
 * JWKS_FAILURE_BACKOFF_MS. Keys past their TTL never verify.
 */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JWKS_FAILURE_BACKOFF_MS,
  JWKS_REFRESH_COOLDOWN_MS,
  JWKS_TTL_MS,
  resetClerkJwksStateForTests,
  verifyClerkJwt,
} from "./clerk-jwt.js";

const ISSUER = "https://clerk.example.test";
const AUDIENCE = "gw";
const JWKS_URL = "https://clerk.example.test/.well-known/jwks.json";
const T0 = new Date("2026-10-29T12:00:00Z");
const NOW_S = Math.floor(T0.getTime() / 1000);

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };

function keypair(kid: string): { privateKey: KeyObject; jwk: Jwk } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Jwk;
  Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
  return { privateKey, jwk };
}

function token(kid: string, privateKey: KeyObject): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${enc({ alg: "RS256", kid, typ: "JWT" })}.${enc({
    sub: "user_abc",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW_S + 3600,
  })}`;
  return `${input}.${cryptoSign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

const A = keypair("kid-a");
const B = keypair("kid-b");
/** Keys the stubbed JWKS endpoint currently serves. */
let served: Jwk[] = [A.jwk];
const fetchStub = vi.fn(
  async () =>
    new Response(JSON.stringify({ keys: served }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

// The network path (no injected fetcher): what production uses.
const opts = { jwksUrl: JWKS_URL, issuer: ISSUER, audience: AUDIENCE, now: NOW_S };

beforeEach(() => {
  resetClerkJwksStateForTests();
  served = [A.jwk];
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
  // Fake only Date: the limiter reads Date.now(); AbortSignal timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetClerkJwksStateForTests();
});

describe("JWKS refetch limit (network path)", () => {
  it("100 tokens with distinct unknown kids: every one rejected, at most ONE refetch", async () => {
    expect((await verifyClerkJwt(token("kid-a", A.privateKey), opts))?.sub).toBe("user_abc");
    expect(fetchStub).toHaveBeenCalledTimes(1); // the warm fetch

    for (let i = 0; i < 100; i++) {
      expect(await verifyClerkJwt(token(`kid-random-${i}`, A.privateKey), opts)).toBeNull();
    }
    expect(fetchStub.mock.calls.length - 1).toBeLessThanOrEqual(1);
  });

  it("100 CONCURRENT unknown kids on a cold cache: all rejected, at most two fetches in total", async () => {
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        verifyClerkJwt(token(`kid-c-${i}`, A.privateKey), opts),
      ),
    );
    expect(results.every((r) => r === null)).toBe(true);
    // One shared cold fetch, plus at most one shared forced refetch.
    expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("a real key rotation still verifies once the cooldown has passed", async () => {
    await verifyClerkJwt(token("kid-a", A.privateKey), opts); // warm with A only
    // An unknown kid uses the refetch slot.
    expect(await verifyClerkJwt(token("kid-nope", A.privateKey), opts)).toBeNull();
    // Clerk rotates to B.
    served = [A.jwk, B.jwk];
    // Inside the cooldown, B fails closed (documented trade-off; no fetch).
    const before = fetchStub.mock.calls.length;
    expect(await verifyClerkJwt(token("kid-b", B.privateKey), opts)).toBeNull();
    expect(fetchStub.mock.calls.length).toBe(before);
    // After the cooldown, B triggers one refetch and verifies.
    vi.setSystemTime(new Date(T0.getTime() + JWKS_REFRESH_COOLDOWN_MS + 1));
    expect((await verifyClerkJwt(token("kid-b", B.privateKey), opts))?.sub).toBe("user_abc");
    expect(fetchStub.mock.calls.length).toBe(before + 1);
  });

  it("a known kid never waits on the cooldown (no extra fetch on the happy path)", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await verifyClerkJwt(token("kid-a", A.privateKey), opts))?.sub).toBe("user_abc");
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("the cooldown is per JWKS URL: another issuer's endpoint is not blocked", async () => {
    await verifyClerkJwt(token("kid-a", A.privateKey), opts);
    await verifyClerkJwt(token("kid-nope", A.privateKey), opts); // uses URL 1's slot
    const other = { ...opts, jwksUrl: "https://other.example.test/.well-known/jwks.json" };
    const before = fetchStub.mock.calls.length;
    await verifyClerkJwt(token("kid-nope2", A.privateKey), other);
    // URL 2: a cold fetch plus its own forced refetch.
    expect(fetchStub.mock.calls.length).toBe(before + 2);
  });

  it("a failed refetch still uses the cooldown slot", async () => {
    await verifyClerkJwt(token("kid-a", A.privateKey), opts);
    fetchStub.mockRejectedValueOnce(new Error("network down"));
    expect(await verifyClerkJwt(token("kid-x", A.privateKey), opts)).toBeNull();
    const before = fetchStub.mock.calls.length;
    expect(await verifyClerkJwt(token("kid-y", A.privateKey), opts)).toBeNull();
    expect(fetchStub.mock.calls.length).toBe(before);
    // A failed refetch leaves the cached entry untouched: known kids still verify.
    expect((await verifyClerkJwt(token("kid-a", A.privateKey), opts))?.sub).toBe("user_abc");
  });

  it("concurrent requests for a newly rotated kid SHARE the one refetch (both verify)", async () => {
    await verifyClerkJwt(token("kid-a", A.privateKey), opts); // warm with A only
    served = [A.jwk, B.jwk]; // Clerk rotated to B
    const before = fetchStub.mock.calls.length;
    const [r1, r2] = await Promise.all([
      verifyClerkJwt(token("kid-b", B.privateKey), opts),
      verifyClerkJwt(token("kid-b", B.privateKey), opts),
    ]);
    expect(r1?.sub).toBe("user_abc");
    expect(r2?.sub).toBe("user_abc");
    expect(fetchStub.mock.calls.length).toBe(before + 1);
  });

  it("inside the cooldown, keys past their TTL are never used (fail closed during an outage)", async () => {
    await verifyClerkJwt(token("kid-a", A.privateKey), opts); // warm with A
    // Past the 10-minute TTL, and the endpoint now fails.
    vi.setSystemTime(new Date(T0.getTime() + JWKS_TTL_MS + 1));
    fetchStub.mockRejectedValue(new Error("network down"));
    // Use the refetch slot with an unknown kid.
    expect(await verifyClerkJwt(token("kid-nope", A.privateKey), opts)).toBeNull();
    // A token for the cached-but-expired kid must not verify against the stale keys.
    expect(await verifyClerkJwt(token("kid-a", A.privateKey), opts)).toBeNull();
    fetchStub.mockReset();
  });

  it("after a failed fetch, new fetches back off briefly (no tight loop while the endpoint fails)", async () => {
    fetchStub.mockRejectedValue(new Error("network down"));
    for (let i = 0; i < 20; i++) {
      expect(await verifyClerkJwt(token("kid-a", A.privateKey), opts)).toBeNull();
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // After the back-off, one new attempt; once the endpoint recovers, it verifies.
    fetchStub.mockReset();
    fetchStub.mockImplementation(
      async () => new Response(JSON.stringify({ keys: served }), { status: 200 }),
    );
    vi.setSystemTime(new Date(T0.getTime() + JWKS_FAILURE_BACKOFF_MS + 1));
    expect((await verifyClerkJwt(token("kid-a", A.privateKey), opts))?.sub).toBe("user_abc");
  });
});
