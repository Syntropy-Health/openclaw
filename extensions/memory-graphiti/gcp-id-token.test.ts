/**
 * Keyless caller identity (Fly OIDC → STS → generateIdToken). Fixture resource
 * names are fake; nothing here reaches Fly or Google.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GraphitiRestClient } from "./client.js";
import {
  createGcpIdTokenSource,
  defaultOidcAudience,
  flyOidcTokenFromSocket,
  gcpIdTokenConfigFromEnv,
  ID_TOKEN_REFRESH_MARGIN_MS,
  MINT_FAILURE_BACKOFF_MS,
  assertIdentityTarget,
  MemoryBackendUnavailableError,
} from "./gcp-id-token.js";

const PROVIDER =
  "projects/123456/locations/global/workloadIdentityPools/test-pool/providers/test-provider";
const SA = "invoker@example-project.iam.gserviceaccount.com";
const AUD = "https://graphiti.example.test";
const T0 = Date.parse("2026-11-02T12:00:00Z");

const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "c2ln",
  ].join(".");
const FLY_TOKEN = jwt({ iss: "https://oidc.fly.io/example-org", aud: "x" });

function google(
  opts: { idAud?: string; expSec?: number; sts?: number; iam?: number } = {},
  clock: () => number = () => T0,
) {
  let n = 0;
  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (url === "https://sts.googleapis.com/v1/token") {
      if (opts.sts) {
        return new Response("no", { status: opts.sts });
      }
      return new Response(
        JSON.stringify({ access_token: "fed-access-token", token_type: "Bearer" }),
      );
    }
    if (url.includes(":generateIdToken")) {
      if (opts.iam) {
        return new Response("no", { status: opts.iam });
      }
      n++;
      const exp = opts.expSec ?? Math.floor(clock() / 1000) + 3600;
      return new Response(JSON.stringify({ token: jwt({ aud: opts.idAud ?? AUD, exp, n }) }));
    }
    return new Response("unexpected", { status: 599 });
  });
  return { fetchImpl, fetch: fetchImpl as unknown as typeof fetch };
}

const source = (
  g: ReturnType<typeof google>,
  extra: { fly?: (aud: string) => Promise<string>; now?: () => number } = {},
) =>
  createGcpIdTokenSource(
    { wifProvider: PROVIDER, invokerServiceAccount: SA, audience: AUD },
    {
      fetch: g.fetch,
      flyOidcToken: extra.fly ?? (async () => FLY_TOKEN),
      now: extra.now ?? (() => T0),
    },
  );

describe("createGcpIdTokenSource", () => {
  it("mints an ID token: Fly OIDC (provider audience) → STS exchange → generateIdToken as the invoker", async () => {
    const g = google();
    const fly = vi.fn(async () => FLY_TOKEN);
    const token = await source(g, { fly }).token();
    expect(token.split(".")).toHaveLength(3);
    expect(fly).toHaveBeenCalledWith(defaultOidcAudience(PROVIDER));
    const [stsUrl, stsInit] = g.fetchImpl.mock.calls[0];
    expect(String(stsUrl)).toBe("https://sts.googleapis.com/v1/token");
    expect(JSON.parse(stsInit?.body as string)).toEqual({
      grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${PROVIDER}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      subjectToken: FLY_TOKEN,
    });
    const [iamUrl, iamInit] = g.fetchImpl.mock.calls[1];
    expect(String(iamUrl)).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:generateIdToken`,
    );
    expect(new Headers(iamInit?.headers).get("authorization")).toBe("Bearer fed-access-token");
    expect(JSON.parse(iamInit?.body as string)).toEqual({ audience: AUD, includeEmail: true });
  });

  it("reuses the cached token until the refresh margin, then mints a new one", async () => {
    let now = T0;
    const g = google({}, () => now);
    const s = source(g, { now: () => now });
    const first = await s.token();
    now = T0 + 3600_000 - ID_TOKEN_REFRESH_MARGIN_MS - 1;
    expect(await s.token()).toBe(first);
    expect(g.fetchImpl).toHaveBeenCalledTimes(2);
    now = T0 + 3600_000 - ID_TOKEN_REFRESH_MARGIN_MS + 1;
    const second = await s.token();
    expect(second).not.toBe(first);
    expect(g.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("RED: an expired token is never returned; it is re-minted", async () => {
    let now = T0;
    const g = google({}, () => now);
    const s = source(g, { now: () => now });
    const first = await s.token();
    now = T0 + 7200_000; // well past exp
    expect(await s.token()).not.toBe(first);
  });

  it("RED: a token minted for another audience is rejected and never reused", async () => {
    let now = T0;
    const g = google({ idAud: "https://someone-else.example.test" }, () => now);
    const s = source(g, { now: () => now });
    await expect(s.token()).rejects.toThrow("audience mismatch");
    // Not served from cache: within the back-off it fails fast, after it re-mints.
    await expect(s.token()).rejects.toThrow("backing off");
    expect(g.fetchImpl).toHaveBeenCalledTimes(2);
    now = T0 + MINT_FAILURE_BACKOFF_MS + 1;
    await expect(s.token()).rejects.toThrow("audience mismatch");
    expect(g.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("a token that is already expired when minted is rejected", async () => {
    const g = google({ expSec: Math.floor(T0 / 1000) - 1 });
    await expect(source(g).token()).rejects.toBeInstanceOf(MemoryBackendUnavailableError);
  });

  it("RED: no Fly OIDC token fails CLOSED as backend_unavailable, before any Google call", async () => {
    const g = google();
    const s = source(g, {
      fly: async () => {
        throw new Error("ECONNREFUSED /.fly/api");
      },
    });
    const err = await s.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryBackendUnavailableError);
    expect((err as MemoryBackendUnavailableError).reason).toBe("backend_unavailable");
    expect(g.fetchImpl).not.toHaveBeenCalled();
  });

  it("STS or IAM failures are backend_unavailable naming the step and status, never a token", async () => {
    for (const [opt, step] of [
      [{ sts: 400 }, "sts token exchange: HTTP 400"],
      [{ iam: 403 }, "generateIdToken: HTTP 403"],
    ] as const) {
      const err = (await source(google(opt))
        .token()
        .catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(MemoryBackendUnavailableError);
      expect(err.message).toBe(step);
      expect(err.message).not.toContain("fed-access-token");
      expect(err.message).not.toContain(FLY_TOKEN);
    }
  });

  it("an STS reply without an access token stops before impersonation", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) =>
      String(input).includes("sts.googleapis.com")
        ? new Response(JSON.stringify({ token_type: "Bearer" }))
        : new Response(JSON.stringify({ token: jwt({ aud: AUD, exp: 9_999_999_999 }) })),
    );
    const s = createGcpIdTokenSource(
      { wifProvider: PROVIDER, invokerServiceAccount: SA, audience: AUD },
      {
        fetch: fetchImpl as unknown as typeof fetch,
        flyOidcToken: async () => FLY_TOKEN,
        now: () => T0,
      },
    );
    await expect(s.token()).rejects.toThrow("sts token exchange: no access token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a far-future exp is cached for at most an hour", async () => {
    let now = T0;
    const g = google({ expSec: Math.floor(T0 / 1000) + 30 * 86_400 }, () => now);
    const s = source(g, { now: () => now });
    const first = await s.token();
    now = T0 + 60 * 60_000 - ID_TOKEN_REFRESH_MARGIN_MS + 1;
    expect(await s.token()).not.toBe(first);
  });

  it("concurrent callers share one mint (single-flight)", async () => {
    const g = google();
    const s = source(g);
    const [a, b, c] = await Promise.all([s.token(), s.token(), s.token()]);
    expect(new Set([a, b, c]).size).toBe(1);
    expect(g.fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("GraphitiRestClient with a caller identity", () => {
  it("every request carries the bearer token", async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_input: string | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers).get("authorization"));
      return new Response(JSON.stringify({ facts: [], next_cursor: null, episodes: [] }), {
        status: 200,
      });
    });
    const c = new GraphitiRestClient("http://g.test", {
      fetch: fetchImpl as unknown as typeof fetch,
      authToken: async () => "id-token-1",
    });
    await c.listFacts("ok_g");
    await c.searchRanked("ok_g", "q", { reranker: "rrf", limit: 3 });
    await c.forget("ok_g").catch(() => undefined);
    await c.addMessages("ok_g", []).catch(() => undefined);
    await c.getEpisodes("ok_g").catch(() => undefined);
    await c.healthcheck();
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.every((h) => h === "Bearer id-token-1")).toBe(true);
  });

  it("authenticated requests never follow a redirect", async () => {
    const fetchImpl = vi.fn(
      async (_i: string | URL, _init: RequestInit = {}) =>
        new Response(JSON.stringify({ facts: [], next_cursor: null })),
    );
    const c = new GraphitiRestClient("http://g.test", {
      fetch: fetchImpl as unknown as typeof fetch,
      authToken: async () => "t",
    });
    await c.listFacts("ok_g");
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("RED: when the identity fails, NO request is sent (never an unauthenticated call)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const c = new GraphitiRestClient("http://g.test", {
      fetch: fetchImpl as unknown as typeof fetch,
      authToken: async () => {
        throw new MemoryBackendUnavailableError("fly oidc token: unavailable");
      },
    });
    await expect(c.listFacts("ok_g")).rejects.toBeInstanceOf(MemoryBackendUnavailableError);
    await expect(c.searchRanked("ok_g", "q", { reranker: "rrf", limit: 3 })).rejects.toBeInstanceOf(
      MemoryBackendUnavailableError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("assertIdentityTarget (the bearer only goes where it is meant to)", () => {
  it("accepts an https serverUrl on the audience's origin", () => {
    expect(() => assertIdentityTarget(`${AUD}/`, AUD)).not.toThrow();
  });
  it("RED: refuses http, another host, or a non-URL", () => {
    expect(() => assertIdentityTarget("http://graphiti.example.test", AUD)).toThrow("https");
    expect(() => assertIdentityTarget("https://elsewhere.example.test", AUD)).toThrow("origin");
    expect(() => assertIdentityTarget("not a url", AUD)).toThrow("not a URL");
  });
});

describe("createClient refuses an identity aimed at the wrong target", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("RED: identity env set + an http or off-origin serverUrl fails at startup", async () => {
    vi.stubEnv("OPENCLAW_GRAPHITI_WIF_PROVIDER", PROVIDER);
    vi.stubEnv("OPENCLAW_GRAPHITI_INVOKER_SA", SA);
    vi.stubEnv("OPENCLAW_GRAPHITI_AUDIENCE", AUD);
    const { createClient } = await import("./index.js");
    const cfg = (serverUrl: string) => ({ backend: "self-hosted", serverUrl }) as never;
    expect(() => createClient(cfg("http://graphiti.example.test"))).toThrow("https");
    expect(() => createClient(cfg("https://elsewhere.example.test"))).toThrow("origin");
    expect(() => createClient(cfg(AUD))).not.toThrow();
  });
});

describe("gcpIdTokenConfigFromEnv", () => {
  const full = {
    OPENCLAW_GRAPHITI_WIF_PROVIDER: PROVIDER,
    OPENCLAW_GRAPHITI_INVOKER_SA: SA,
    OPENCLAW_GRAPHITI_AUDIENCE: AUD,
  };
  it("none set: no identity (a local graphiti-server)", () => {
    expect(gcpIdTokenConfigFromEnv({})).toBeNull();
  });
  it("all set: the config", () => {
    expect(gcpIdTokenConfigFromEnv(full)).toEqual({
      wifProvider: PROVIDER,
      invokerServiceAccount: SA,
      audience: AUD,
      oidcAudience: undefined,
    });
  });
  it("RED: a partial set is a startup error naming what is missing", () => {
    const { OPENCLAW_GRAPHITI_AUDIENCE: _a, ...partial } = full;
    expect(() => gcpIdTokenConfigFromEnv(partial)).toThrow("missing OPENCLAW_GRAPHITI_AUDIENCE");
  });
  it("a provider that is not a resource name is a startup error", () => {
    expect(() =>
      gcpIdTokenConfigFromEnv({ ...full, OPENCLAW_GRAPHITI_WIF_PROVIDER: "test-provider" }),
    ).toThrow("not a provider resource name");
  });
});

describe("flyOidcTokenFromSocket (a real Unix socket standing in for the Machine API)", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  const serve = async (reply: (body: string) => { status: number; body: string }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fly-api-"));
    const sock = path.join(dir, "api.sock");
    const got: { method?: string; url?: string; body?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        Object.assign(got, { method: req.method, url: req.url, body });
        const r = reply(body);
        res.writeHead(r.status);
        res.end(r.body);
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, () => r()));
    return { sock, got };
  };

  it("POST /v1/tokens/oidc with {aud}; a raw JWT body is the token", async () => {
    const { sock, got } = await serve(() => ({ status: 200, body: FLY_TOKEN }));
    expect(await flyOidcTokenFromSocket("aud-x", sock)).toBe(FLY_TOKEN);
    expect(got).toMatchObject({ method: "POST", url: "/v1/tokens/oidc" });
    expect(JSON.parse(got.body ?? "")).toEqual({ aud: "aud-x" });
  });

  it("a {token} JSON body is accepted too", async () => {
    const { sock } = await serve(() => ({
      status: 200,
      body: JSON.stringify({ token: FLY_TOKEN }),
    }));
    expect(await flyOidcTokenFromSocket("a", sock)).toBe(FLY_TOKEN);
  });

  it("an oversized reply fails closed (even one shaped like a JWT)", async () => {
    const { sock } = await serve(() => ({ status: 200, body: `aaa.${"b".repeat(64 * 1024)}.ccc` }));
    await expect(flyOidcTokenFromSocket("a", sock)).rejects.toBeInstanceOf(
      MemoryBackendUnavailableError,
    );
  });

  it("an error status, a non-JWT body, or no socket all fail closed", async () => {
    const bad = await serve(() => ({ status: 500, body: "boom" }));
    await expect(flyOidcTokenFromSocket("a", bad.sock)).rejects.toThrow("HTTP 500");
    const junk = await serve(() => ({ status: 200, body: "not-a-token" }));
    await expect(flyOidcTokenFromSocket("a", junk.sock)).rejects.toThrow("not a JWT");
    await expect(flyOidcTokenFromSocket("a", "/nonexistent/fly.sock")).rejects.toBeInstanceOf(
      MemoryBackendUnavailableError,
    );
  });
});
