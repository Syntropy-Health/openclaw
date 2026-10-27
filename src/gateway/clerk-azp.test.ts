// Clerk `azp` (authorized party) verification against a configured allow-list,
// its config/env threading, the per-process observation log, and the boot WARN.
//
// The allow-list is OPT-IN: with no list configured the verifier behaves exactly
// as before (no azp check), so operators can first observe real azp values via
// the `clerk: observed azp=…` info line and only then enforce.

import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[] }));

vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  return {
    ...actual,
    logInfo: vi.fn((m: string) => {
      logs.info.push(m);
    }),
    logWarn: vi.fn((m: string) => {
      logs.warn.push(m);
    }),
  };
});

import {
  authorizeClerkJwt,
  createAzpObserver,
  resolveClerkAuth,
  type ResolvedClerkAuth,
} from "./auth.js";
import { verifyClerkJwt } from "./clerk-jwt.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const NOW = 1_700_000_000;
const ISSUER = "https://clerk.syntropyhealth.test";
const AUDIENCE = "syntropy-gateway";
const KID = "azp-kid-1";
const GOOD = "https://shrinelongevity.com";
const EVIL = "https://evil.example";

type JwkWithMeta = JsonWebKey & { kid?: string; alg?: string; use?: string };

function makeKeypair(kid: string): { privateKey: KeyObject; jwk: JwkWithMeta } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as JwkWithMeta;
  jwk.kid = kid;
  jwk.alg = "RS256";
  jwk.use = "sig";
  return { privateKey, jwk };
}

const { privateKey, jwk } = makeKeypair(KID);

function mint(over: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { sub: "user_abc", iss: ISSUER, aud: AUDIENCE, exp: NOW + 3600, ...over };
  for (const [k, v] of Object.entries(claims)) {
    if (v === undefined) {
      delete (claims as Record<string, unknown>)[k];
    }
  }
  const input = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64(claims)}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  return `${input}.${sig}`;
}

const fetchJwks = async () => ({ keys: [jwk as JsonWebKey] });

function opts(over: Partial<Parameters<typeof verifyClerkJwt>[1]> = {}) {
  return {
    jwksUrl: "https://jwks.test/keys",
    issuer: ISSUER,
    audience: AUDIENCE,
    now: NOW,
    fetchJwks,
    ...over,
  };
}

beforeEach(() => {
  logs.info.length = 0;
  logs.warn.length = 0;
});

describe("verifyClerkJwt — azp allow-list (RED arm)", () => {
  it("★ rejects azp https://evil.example when the list is [https://shrinelongevity.com]", async () => {
    const token = mint({ azp: EVIL });
    expect(await verifyClerkJwt(token, opts({ authorizedParties: [GOOD] }))).toBeNull();
  });

  it("accepts a matching azp", async () => {
    const token = mint({ azp: GOOD });
    expect((await verifyClerkJwt(token, opts({ authorizedParties: [GOOD] })))?.sub).toBe(
      "user_abc",
    );
  });

  it("rejects an ABSENT azp when a list is set (unless allowMissingAzp)", async () => {
    const token = mint();
    expect(await verifyClerkJwt(token, opts({ authorizedParties: [GOOD] }))).toBeNull();
    expect(
      await verifyClerkJwt(token, opts({ authorizedParties: [GOOD], allowMissingAzp: false })),
    ).toBeNull();
    expect(
      (await verifyClerkJwt(token, opts({ authorizedParties: [GOOD], allowMissingAzp: true })))
        ?.sub,
    ).toBe("user_abc");
  });

  it("allowMissingAzp never admits a PRESENT but unlisted azp", async () => {
    const token = mint({ azp: EVIL });
    expect(
      await verifyClerkJwt(token, opts({ authorizedParties: [GOOD], allowMissingAzp: true })),
    ).toBeNull();
  });

  it("rejects a non-string azp when a list is set", async () => {
    const token = mint({ azp: 42 });
    expect(await verifyClerkJwt(token, opts({ authorizedParties: [GOOD] }))).toBeNull();
  });

  it("characterization: list unset or empty → accepted regardless of azp", async () => {
    for (const azp of [EVIL, GOOD, undefined]) {
      const token = mint({ azp });
      expect((await verifyClerkJwt(token, opts()))?.sub).toBe("user_abc");
      expect((await verifyClerkJwt(token, opts({ authorizedParties: [] })))?.sub).toBe("user_abc");
    }
  });
});

describe("resolveClerkAuth — authorizedParties / allowMissingAzp", () => {
  const BASE_ENV = {
    OPENCLAW_CLERK_JWKS_URL: "https://jwks.test/keys",
    OPENCLAW_CLERK_ISSUER: ISSUER,
    OPENCLAW_CLERK_AUDIENCE: AUDIENCE,
  };
  const env = (over: Record<string, string> = {}) =>
    ({ ...BASE_ENV, ...over }) as NodeJS.ProcessEnv;

  it("parses OPENCLAW_CLERK_AUTHORIZED_PARTIES: comma-separated, trimmed, empties dropped", () => {
    const clerk = resolveClerkAuth(
      undefined,
      env({ OPENCLAW_CLERK_AUTHORIZED_PARTIES: ` ${GOOD} ,, https://app.test ,` }),
    );
    expect(clerk?.authorizedParties).toEqual([GOOD, "https://app.test"]);
  });

  it("unset / blank env → no list (no enforcement)", () => {
    expect(resolveClerkAuth(undefined, env())?.authorizedParties).toBeUndefined();
    expect(
      resolveClerkAuth(undefined, env({ OPENCLAW_CLERK_AUTHORIZED_PARTIES: " , " }))
        ?.authorizedParties,
    ).toBeUndefined();
  });

  it("the two azp knobs are env-only: config keys of the same name are IGNORED", () => {
    // Trust anchors must not be writable through config.patch (agent-reachable).
    const injected = {
      authorizedParties: [EVIL],
      allowMissingAzp: true,
    } as unknown as Parameters<typeof resolveClerkAuth>[0];
    const fromEnvOnly = resolveClerkAuth(
      injected,
      env({ OPENCLAW_CLERK_AUTHORIZED_PARTIES: GOOD, OPENCLAW_CLERK_ALLOW_MISSING_AZP: "0" }),
    );
    expect(fromEnvOnly?.authorizedParties).toEqual([GOOD]);
    expect(fromEnvOnly?.allowMissingAzp).toBe(false);
    expect(resolveClerkAuth(injected, env())?.authorizedParties).toBeUndefined();
  });

  it("OPENCLAW_CLERK_ALLOW_MISSING_AZP accepts 1 / true / yes / on, case-insensitive", () => {
    const allow = (v: string) =>
      resolveClerkAuth(undefined, env({ OPENCLAW_CLERK_ALLOW_MISSING_AZP: v }))?.allowMissingAzp;
    for (const v of ["1", "true", " TRUE ", "yes", "YES", "on", "On"]) {
      expect(allow(v)).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", "", "2", "y"]) {
      expect(allow(v)).toBe(false);
    }
    expect(resolveClerkAuth(undefined, env())?.allowMissingAzp).toBe(false);
  });
});

describe("azp normalisation (trailing slash, scheme+host case)", () => {
  it("a list entry with a trailing slash matches an azp without one", async () => {
    const token = mint({ azp: GOOD });
    expect((await verifyClerkJwt(token, opts({ authorizedParties: [`${GOOD}/`] })))?.sub).toBe(
      "user_abc",
    );
  });

  it("an azp with a trailing slash matches a list entry without one", async () => {
    const token = mint({ azp: `${GOOD}/` });
    expect((await verifyClerkJwt(token, opts({ authorizedParties: [GOOD] })))?.sub).toBe(
      "user_abc",
    );
  });

  it("scheme and host compare case-insensitively on both sides", async () => {
    const token = mint({ azp: "HTTPS://ShrineLongevity.COM" });
    expect(
      (await verifyClerkJwt(token, opts({ authorizedParties: ["https://SHRINELONGEVITY.com/"] })))
        ?.sub,
    ).toBe("user_abc");
  });

  it("normalisation does not widen: a different host or a path still fails", async () => {
    for (const azp of [
      "https://shrinelongevity.com.evil.example",
      "https://shrinelongevity.com/x",
      "http://shrinelongevity.com",
    ]) {
      const token = mint({ azp });
      expect(await verifyClerkJwt(token, opts({ authorizedParties: [GOOD] }))).toBeNull();
    }
  });
});

describe("authorizeClerkJwt — threads the allow-list and observes azp", () => {
  const CLERK: ResolvedClerkAuth = {
    jwksUrl: "https://jwks.test/keys",
    issuer: ISSUER,
    audience: AUDIENCE,
    authorizedParties: [GOOD],
  };

  it("★ rejects an unlisted azp through the gateway entry point", async () => {
    const res = await authorizeClerkJwt(mint({ azp: EVIL }), CLERK, {
      now: NOW,
      fetchJwks,
      onObservedAzp: () => {},
    });
    expect(res.ok).toBe(false);
  });

  it("accepts a listed azp and reports it to the observer (success only)", async () => {
    const seen: unknown[] = [];
    const ok = await authorizeClerkJwt(mint({ azp: GOOD }), CLERK, {
      now: NOW,
      fetchJwks,
      onObservedAzp: (azp) => seen.push(azp),
    });
    expect(ok.ok).toBe(true);
    await authorizeClerkJwt(mint({ azp: EVIL }), CLERK, {
      now: NOW,
      fetchJwks,
      onObservedAzp: (azp) => seen.push(azp),
    });
    expect(seen).toEqual([GOOD]);
  });
});

describe("createAzpObserver — once per distinct value, capped, sanitized", () => {
  it("logs once per distinct azp, and `absent` for a missing one", () => {
    const lines: string[] = [];
    const observe = createAzpObserver((m) => lines.push(m));
    observe(GOOD);
    observe(GOOD);
    observe(undefined);
    observe(undefined);
    expect(lines).toEqual([`clerk: observed azp=${GOOD}`, "clerk: observed azp=absent"]);
  });

  it("sanitizes to [A-Za-z0-9:/._-] and caps at 100 chars", () => {
    const lines: string[] = [];
    const observe = createAzpObserver((m) => lines.push(m));
    observe("https://a.test/x?y=<script>\n");
    observe(`https://${"a".repeat(300)}`);
    expect(lines[0]).toBe("clerk: observed azp=https://a.test/x_y__script__");
    const value = lines[1].slice("clerk: observed azp=".length);
    expect(value).toHaveLength(100);
    expect(value).toMatch(/^[A-Za-z0-9:/._-]+$/);
  });

  it("stops after 20 distinct values", () => {
    const lines: string[] = [];
    const observe = createAzpObserver((m) => lines.push(m));
    for (let i = 0; i < 30; i++) {
      observe(`https://p${i}.test`);
    }
    expect(lines).toHaveLength(20);
    expect(lines.at(-1)).toBe("clerk: observed azp=https://p19.test");
  });

  it("never logs the token or other claims (only the azp value is passed in)", async () => {
    const lines: string[] = [];
    const observe = createAzpObserver((m) => lines.push(m));
    const token = mint({ azp: GOOD, sid: "sess_secret" });
    await authorizeClerkJwt(
      token,
      { ...CLERK_NO_LIST },
      { now: NOW, fetchJwks, onObservedAzp: observe },
    );
    const all = lines.join("\n");
    expect(all).not.toContain(token);
    expect(all).not.toContain("user_abc");
    expect(all).not.toContain("sess_secret");
    expect(lines).toEqual([`clerk: observed azp=${GOOD}`]);
  });
});

const CLERK_NO_LIST: ResolvedClerkAuth = {
  jwksUrl: "https://jwks.test/keys",
  issuer: ISSUER,
  audience: AUDIENCE,
};

describe("boot — azp enforcement status is logged once", () => {
  const base = { bind: "loopback" as const, auth: { mode: "token" as const, token: "t-123" } };
  const clerk = { jwksUrl: "https://x/jwks.json", issuer: "clerk.example.test", audience: "oc" };
  const WARN = "clerk: azp not enforced (set OPENCLAW_CLERK_AUTHORIZED_PARTIES)";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warns once when no authorizedParties are configured", async () => {
    vi.stubEnv("OPENCLAW_CLERK_AUTHORIZED_PARTIES", "");
    await resolveGatewayRuntimeConfig({
      cfg: { gateway: { ...base, auth: { ...base.auth, clerk } } },
      port: 18791,
    });
    expect(logs.warn.filter((m) => m.includes("azp not enforced"))).toEqual([WARN]);
    expect(logs.info.filter((m) => m.startsWith("clerk: azp"))).toEqual([
      "clerk: azp allow-list count=0 allowMissingAzp=false",
    ]);
  });

  it("with env parties set: no WARN; logs the COUNT and the boolean, never the values", async () => {
    vi.stubEnv("OPENCLAW_CLERK_AUTHORIZED_PARTIES", `${GOOD},https://app.test`);
    vi.stubEnv("OPENCLAW_CLERK_ALLOW_MISSING_AZP", "yes");
    await resolveGatewayRuntimeConfig({
      cfg: { gateway: { ...base, auth: { ...base.auth, clerk } } },
      port: 18792,
    });
    expect(logs.warn.some((m) => m.includes("azp not enforced"))).toBe(false);
    const azpLines = logs.info.filter((m) => m.startsWith("clerk: azp"));
    expect(azpLines).toEqual(["clerk: azp allow-list count=2 allowMissingAzp=true"]);
    expect([...logs.info, ...logs.warn].join("\n")).not.toContain("app.test");
  });

  it("does not log azp status when Clerk is not configured", async () => {
    await resolveGatewayRuntimeConfig({ cfg: { gateway: base }, port: 18793 });
    expect([...logs.warn, ...logs.info].some((m) => m.includes("azp"))).toBe(false);
  });
});
