import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedClerkAuth } from "../../../src/gateway/auth.js";
import { createMobileSignoutHandler, type SignoutRouteDeps } from "./signout-route.js";

const CLERK: ResolvedClerkAuth = {
  jwksUrl: "https://jwks.test/keys",
  issuer: "https://clerk.example.test",
  audience: "openclaw",
};

function fakeReq(opts: {
  method?: string;
  headers?: Record<string, string | string[]>;
}): IncomingMessage {
  return { method: opts.method ?? "POST", headers: opts.headers ?? {} } as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0, body: undefined as unknown };
  const res = {
    writeHead: (s: number) => {
      state.status = s;
      return res;
    },
    end: (b?: string) => {
      state.body = b ? JSON.parse(b) : undefined;
    },
  };
  return { res: res as unknown as ServerResponse, state };
}

function makeDeps(overrides: Partial<SignoutRouteDeps> = {}): SignoutRouteDeps & {
  unlinkCalls: Array<{ externalId: string; channel: string; channelPeerId: string }>;
  denied: string[];
} {
  const unlinkCalls: Array<{ externalId: string; channel: string; channelPeerId: string }> = [];
  const denied: string[] = [];
  return {
    unlinkCalls,
    denied,
    resolveClerk: () => CLERK,
    verifyJwt: async () => ({ ok: true as const, externalId: "user_2abc", sid: "sess_1" }),
    unlink: async (params) => {
      unlinkCalls.push(params);
      return 1;
    },
    denySession: (sid) => {
      denied.push(sid);
    },
    ...overrides,
  };
}

const AUTHED = { authorization: "Bearer aaa.bbb.ccc", "x-openclaw-device-id": "device-uuid-1" };

describe("POST /gateway/mobile/signout (G-lane [G2])", () => {
  it("★ happy path: verifies JWT, unbinds the caller's OWN (shrinemobile, device) link, denies the sid, 200", async () => {
    const deps = makeDeps();
    const handler = createMobileSignoutHandler(deps);
    const { res, state } = fakeRes();
    await handler(fakeReq({ headers: AUTHED }), res);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({ ok: true, unbound: true });
    expect(deps.unlinkCalls).toEqual([
      { externalId: "user_2abc", channel: "shrinemobile", channelPeerId: "device-uuid-1" },
    ]);
    expect(deps.denied).toEqual(["sess_1"]); // [G2b] replay window closed
  });

  it("non-POST → 405", async () => {
    const deps = makeDeps();
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ method: "GET", headers: AUTHED }), res);
    expect(state.status).toBe(405);
    expect(deps.unlinkCalls).toHaveLength(0);
  });

  it("★ missing bearer → 401, no unbind, no deny (fail-closed)", async () => {
    const deps = makeDeps();
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(
      fakeReq({ headers: { "x-openclaw-device-id": "device-uuid-1" } }),
      res,
    );
    expect(state.status).toBe(401);
    expect(deps.unlinkCalls).toHaveLength(0);
    expect(deps.denied).toHaveLength(0);
  });

  it("★ invalid JWT → 401, no unbind (you cannot unbind without proving who you are)", async () => {
    const deps = makeDeps({ verifyJwt: async () => ({ ok: false as const }) });
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(state.status).toBe(401);
    expect(deps.unlinkCalls).toHaveLength(0);
  });

  it("Clerk unconfigured → 401 by absence (never a silent no-auth unbind)", async () => {
    const deps = makeDeps({ resolveClerk: () => undefined });
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(state.status).toBe(401);
    expect(deps.unlinkCalls).toHaveLength(0);
  });

  it("missing X-OpenClaw-Device-Id → 400 (no target row derivable)", async () => {
    const deps = makeDeps();
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(
      fakeReq({ headers: { authorization: "Bearer aaa.bbb.ccc" } }),
      res,
    );
    expect(state.status).toBe(400);
    expect(deps.unlinkCalls).toHaveLength(0);
  });

  it("★ idempotent: an absent/already-unbound link → 200 with unbound:false (unbind twice → 200 both)", async () => {
    const deps = makeDeps({
      unlink: async () => 0, // nothing matched (already unbound or never bound)
    });
    const handler = createMobileSignoutHandler(deps);
    const first = fakeRes();
    await handler(fakeReq({ headers: AUTHED }), first.res);
    const second = fakeRes();
    await handler(fakeReq({ headers: AUTHED }), second.res);
    expect(first.state.status).toBe(200);
    expect(second.state.status).toBe(200);
    expect(first.state.body).toEqual({ ok: true, unbound: false });
  });

  it("still denies the sid on a no-op unbind (second sign-out still revokes a live session)", async () => {
    const deps = makeDeps({ unlink: async () => 0 });
    const { res } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(deps.denied).toEqual(["sess_1"]);
  });

  it("a token without sid unbinds fine and denies nothing", async () => {
    const deps = makeDeps({
      verifyJwt: async () => ({ ok: true as const, externalId: "user_2abc" }),
    });
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(state.status).toBe(200);
    expect(deps.denied).toHaveLength(0);
  });

  it("★ DB failure → 500 (loud), but the sid IS already denied (consent-kill survives the outage)", async () => {
    const deps = makeDeps({
      unlink: async () => {
        throw new Error("pg down");
      },
    });
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(state.status).toBe(500);
    expect(deps.denied).toEqual(["sess_1"]); // denied BEFORE the unlink attempt
  });

  it("verifyJwt throwing is treated as invalid → 401 (never crashes the route)", async () => {
    const deps = makeDeps({
      verifyJwt: async () => {
        throw new Error("jwks fetch failed");
      },
    });
    const { res, state } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(state.status).toBe(401);
  });

  it("uses the vi spy contract cleanly (deps are injectable)", async () => {
    const verifyJwt = vi.fn(async () => ({ ok: true as const, externalId: "user_x" }));
    const deps = makeDeps({ verifyJwt });
    const { res } = fakeRes();
    await createMobileSignoutHandler(deps)(fakeReq({ headers: AUTHED }), res);
    expect(verifyJwt).toHaveBeenCalledWith("aaa.bbb.ccc", CLERK);
  });
});

// ---------------------------------------------------------------------------
// OBSERVABILITY (T1.2.2 post-mortem): every outcome must be visible server-side.
// v1 logged ONLY success, so after a live sign-out left the row in place it was
// undecidable whether the app never called or called-and-was-rejected.
// ---------------------------------------------------------------------------

describe("mobile-signout observability", () => {
  function withLogs(overrides: Partial<SignoutRouteDeps> = {}) {
    const info: string[] = [];
    const warn: string[] = [];
    const error: string[] = [];
    const deps = makeDeps({
      ...overrides,
      logger: {
        info: (m: string) => info.push(m),
        warn: (m: string) => warn.push(m),
        error: (m: string) => error.push(m),
      },
    });
    return { deps, info, warn, error, all: () => [...info, ...warn, ...error].join(" | ") };
  }

  it("★ logs ARRIVAL before any validation — a call is provable even when later rejected", async () => {
    const { deps, info } = withLogs();
    const { res } = fakeRes();
    // Wrong method: rejected at the very first gate, yet arrival must be logged.
    await createMobileSignoutHandler(deps)(fakeReq({ method: "GET", headers: AUTHED }), res);
    expect(info.join(" ")).toContain("unbind attempt");
  });

  it("★ every rejection names a REASON and says NO unbind performed", async () => {
    const cases: Array<[string, Parameters<typeof fakeReq>[0], Partial<SignoutRouteDeps>, RegExp]> =
      [
        ["wrong method", { method: "GET", headers: AUTHED }, {}, /405.*wrong-method/],
        ["no bearer", { headers: { "x-openclaw-device-id": "d1" } }, {}, /401.*no-bearer/],
        [
          "clerk unconfigured",
          { headers: AUTHED },
          { resolveClerk: () => undefined },
          /401.*clerk-not-configured/,
        ],
        [
          "invalid token",
          { headers: AUTHED },
          { verifyJwt: async () => ({ ok: false as const }) },
          /401.*invalid-token/,
        ],
        [
          "missing device id",
          { headers: { authorization: "Bearer a.b.c" } },
          {},
          /400.*missing-device-id/,
        ],
      ];
    for (const [label, reqOpts, overrides, pattern] of cases) {
      const { deps, warn } = withLogs(overrides);
      const { res } = fakeRes();
      await createMobileSignoutHandler(deps)(fakeReq(reqOpts), res);
      const joined = warn.join(" | ");
      expect(joined, `case: ${label}`).toMatch(pattern);
      expect(joined, `case: ${label}`).toContain("NO unbind performed");
    }
  });

  it("★ success logs the ROW COUNT — 200-with-rowsDeleted=0 is the ineffective-unbind signature", async () => {
    const effective = withLogs();
    const r1 = fakeRes();
    await createMobileSignoutHandler(effective.deps)(fakeReq({ headers: AUTHED }), r1.res);
    expect(effective.info.join(" ")).toContain("rowsDeleted=1");

    const noop = withLogs({ unlink: async () => 0 });
    const r2 = fakeRes();
    await createMobileSignoutHandler(noop.deps)(fakeReq({ headers: AUTHED }), r2.res);
    const joined = noop.info.join(" ");
    expect(joined).toContain("rowsDeleted=0");
    // Both return 200 by idempotency design, so the log is the ONLY way to tell
    // an effective unbind from one that matched nothing.
    expect(joined).toContain("NO-OP");
    expect(r2.state.status).toBe(200);
  });

  it("★ NEVER echoes the bearer token in any log line (presence only)", async () => {
    const secret = "supersecret.jwt.value";
    const { deps, all } = withLogs();
    const { res } = fakeRes();
    await createMobileSignoutHandler(deps)(
      fakeReq({ headers: { authorization: `Bearer ${secret}`, "x-openclaw-device-id": "d1" } }),
      res,
    );
    expect(all()).not.toContain(secret);
    expect(all()).toContain("bearer=present");
  });
});
