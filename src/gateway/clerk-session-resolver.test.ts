import { describe, expect, it, vi } from "vitest";
import { createClerkSessionResolver } from "./clerk-session-resolver.js";

function fakeFetch(status: number, body?: unknown): typeof fetch {
  return vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body ?? {},
  })) as unknown as typeof fetch;
}

const CFG = { secretKey: "sk_test_secret", apiBaseUrl: "https://api.clerk.test" };

describe("createClerkSessionResolver — Clerk backend adapter", () => {
  it("200 active + user_id → active", async () => {
    const r = createClerkSessionResolver({
      ...CFG,
      fetchImpl: fakeFetch(200, { status: "active", user_id: "user_1" }),
    });
    expect(await r("sess_1")).toEqual({ status: "active", userId: "user_1" });
  });

  it("★ every dead status collapses to revoked", async () => {
    for (const s of ["revoked", "expired", "ended", "removed", "abandoned", "replaced"]) {
      const r = createClerkSessionResolver({
        ...CFG,
        fetchImpl: fakeFetch(200, { status: s, user_id: "user_1" }),
      });
      expect(await r("sess_1"), `status=${s}`).toEqual({ status: "revoked" });
    }
  });

  it("404 → not_found", async () => {
    const r = createClerkSessionResolver({ ...CFG, fetchImpl: fakeFetch(404) });
    expect(await r("sess_x")).toEqual({ status: "not_found" });
  });

  it("★ 401/403 (bad/absent secret) → UNREACHABLE, never 'revoked' — a misconfig must fail OPEN, not lock everyone out", async () => {
    for (const code of [401, 403]) {
      const r = createClerkSessionResolver({ ...CFG, fetchImpl: fakeFetch(code) });
      expect(await r("sess_1"), `code=${code}`).toEqual({ status: "unreachable" });
    }
  });

  it("5xx → unreachable", async () => {
    const r = createClerkSessionResolver({ ...CFG, fetchImpl: fakeFetch(503) });
    expect(await r("sess_1")).toEqual({ status: "unreachable" });
  });

  it("network throw / timeout → unreachable", async () => {
    const r = createClerkSessionResolver({
      ...CFG,
      fetchImpl: (async () => {
        throw new Error("aborted");
      }) as unknown as typeof fetch,
    });
    expect(await r("sess_1")).toEqual({ status: "unreachable" });
  });

  it("200 active but MISSING user_id → conservatively revoked (a reached Clerk fails closed on ambiguity)", async () => {
    const r = createClerkSessionResolver({
      ...CFG,
      fetchImpl: fakeFetch(200, { status: "active" }),
    });
    expect(await r("sess_1")).toEqual({ status: "revoked" });
  });

  it("★ never leaks the secret and sends it as a Bearer to the sessions endpoint", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const spy = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return { status: 200, ok: true, json: async () => ({ status: "active", user_id: "user_1" }) };
    }) as unknown as typeof fetch;
    const r = createClerkSessionResolver({ ...CFG, fetchImpl: spy });
    await r("sess_abc");
    expect(seen[0].url).toBe("https://api.clerk.test/v1/sessions/sess_abc");
    expect(seen[0].headers.authorization).toBe("Bearer sk_test_secret");
  });
});
