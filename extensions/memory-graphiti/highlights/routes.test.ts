/**
 * GET /gateway/memory/highlights and POST /gateway/memory/highlights/remove
 * (A&D §1a, §1b, §4.9; PLAN P6.1, P6.2 route arms).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryCapabilityError,
  type ListFactsResult,
  type MemoryCapabilities,
  type MemoryFact,
} from "../client.js";
import { FakeHighlightStore } from "../testing/fake-highlight-store.js";
import type { RemoveResult } from "./remove.js";
import {
  HIGHLIGHTS_CONTRACT,
  createHighlightsHandler,
  createRemoveHighlightHandler,
  type HighlightsRouteDeps,
  type RemoveRouteDeps,
} from "./routes.js";
import type { Highlight } from "./types.js";

// ---- tiny HTTP doubles --------------------------------------------------------

/** A paused readable like a real IncomingMessage: the body waits until it is read. */
function req(method: string, headers: Record<string, string> = {}, body?: string): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    headers,
    url: "/x",
  }) as unknown as IncomingMessage;
}
function res() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: "" };
  const r = {
    writeHead: (s: number, h: Record<string, unknown>) => {
      out.status = s;
      out.headers = h;
      return r;
    },
    end: (b?: string) => {
      out.body = b ?? "";
    },
  } as unknown as ServerResponse;
  return { r, out, json: () => JSON.parse(out.body) as Record<string, unknown> };
}

// ---- auth: "Bearer a" is user A, "Bearer b" is user B ------------------------

const auth = {
  resolveClerk: () => ({ issuer: "x" }) as never,
  verifyJwt: async (t: string) =>
    t === "a"
      ? { ok: true as const, externalId: "user_A" }
      : t === "b"
        ? { ok: true as const, externalId: "user_B" }
        : { ok: false as const },
};
const A = { authorization: "Bearer a" };
const B = { authorization: "Bearer b" };
const groupFor = (sub: string) => `ok_${sub}`;

const fact = (id: string, daysAgo: number): MemoryFact => ({
  id,
  fact: `fact ${id}`,
  name: "R",
  validAt: null,
  invalidAt: null,
  createdAt: new Date(Date.parse("2026-10-29T00:00:00Z") - daysAgo * 86_400_000).toISOString(),
  expiredAt: null,
  episodeIds: [],
});
const hl = (id: string): Highlight => ({
  id,
  category: "sleep",
  title: `title ${id}`,
  body: "b.",
  first_seen: "2026-10-20",
  last_seen: "2026-10-28",
  occurrences: 1,
  recurring: false,
  score: 1,
  sources: [{ fact_id: `e_${id}`, fact: "x", last_seen: "2026-10-28" }],
});

function getSetup(
  opts: { caps?: Partial<MemoryCapabilities>; list?: () => Promise<ListFactsResult> } = {},
) {
  const store = new FakeHighlightStore();
  const facts = new Map<string, MemoryFact[]>([
    ["ok_user_A", [fact("a_old", 5), fact("a_new", 1)]],
    ["ok_user_B", [fact("b_1", 1)]],
  ]);
  const listFacts = vi.fn(
    opts.list ?? (async (g: string) => ({ facts: facts.get(g) ?? [], nextCursor: null })),
  );
  const requestNow = vi.fn(async () => true);
  const deps: HighlightsRouteDeps = {
    ...auth,
    highlights: {
      groupFor,
      store,
      client: {
        listFacts: listFacts as never,
        capabilities: () => ({
          listFacts: true,
          forgetFacts: true,
          rerankers: ["rrf"],
          scores: true,
          ...opts.caps,
        }),
      },
      requestNow,
    },
  };
  return { store, listFacts, requestNow, handler: createHighlightsHandler(deps) };
}

async function get(handler: ReturnType<typeof createHighlightsHandler>, headers = A) {
  const x = res();
  await handler(req("GET", headers), x.r);
  return x;
}

describe("GET /gateway/memory/highlights", () => {
  it("405 for other methods; 401 without a valid token", async () => {
    const { handler } = getSetup();
    const p = res();
    await handler(req("POST", A), p.r);
    expect(p.out.status).toBe(405);
    const u = await get(handler, { authorization: "Bearer nope" });
    expect(u.out.status).toBe(401);
    expect(u.out.headers["cache-control"]).toBe("no-store");
  });

  it("not enabled: not_enabled after auth, nothing revealed", async () => {
    const handler = createHighlightsHandler({ ...auth, highlights: null });
    const x = await get(handler);
    expect(x.json()).toEqual({
      contract: HIGHLIGHTS_CONTRACT,
      state: "not_enabled",
      generated_at: null,
      stale: false,
      reason: null,
      highlights: [],
      fallback_facts: null,
    });
    expect((await get(handler, { authorization: "Bearer nope" })).out.status).toBe(401);
  });

  it("first read with no row: unavailable + raw recent facts + stale:true; generation queued", async () => {
    const { handler, requestNow } = getSetup();
    const x = await get(handler);
    expect(x.out.status).toBe(200);
    expect(x.json()).toMatchObject({
      state: "unavailable",
      generated_at: null,
      stale: true,
      reason: null,
      highlights: [],
      fallback_facts: [
        { fact_id: "a_new", fact: "fact a_new", last_seen: "2026-10-28" },
        { fact_id: "a_old", fact: "fact a_old", last_seen: "2026-10-24" },
      ],
    });
    expect(requestNow).toHaveBeenCalledWith("ok_user_A");
  });

  it("ready: the cached highlights as stored, with generated_at and stale", async () => {
    const { handler, store } = getSetup();
    await store.claimOnDemand("ok_user_A", 3);
    await store.put(
      "ok_user_A",
      { state: "ready", payload: [hl("1"), hl("2")] },
      await store.clock(),
    );
    const x = await get(handler);
    expect(x.json()).toMatchObject({
      state: "ready",
      stale: false,
      reason: null,
      fallback_facts: null,
    });
    expect((x.json().highlights as Highlight[]).map((h) => h.id)).toEqual(["1", "2"]);
    expect(typeof x.json().generated_at).toBe("string");
    await store.markStale("ok_user_A");
    expect((await get(handler)).json().stale).toBe(true);
  });

  it("empty: zero facts", async () => {
    const { handler, store } = getSetup();
    await store.claimOnDemand("ok_user_A", 3);
    await store.put("ok_user_A", { state: "empty", payload: [] }, await store.clock());
    expect((await get(handler)).json()).toMatchObject({
      state: "empty",
      highlights: [],
      fallback_facts: null,
    });
  });

  it("a failed generation with the day's cap used: summariser_error, fallback, not stale", async () => {
    const { handler, store, requestNow } = getSetup();
    await store.claimOnDemand("ok_user_A", 3);
    await store.put("ok_user_A", { state: "unavailable", payload: [] }, await store.clock());
    requestNow.mockResolvedValue(false);
    expect((await get(handler)).json()).toMatchObject({
      state: "unavailable",
      reason: "summariser_error",
      stale: false,
    });
  });

  it("backend_unsupported (declared): unavailable, no fallback, nothing queued", async () => {
    const { handler, requestNow, listFacts } = getSetup({ caps: { listFacts: false } });
    expect((await get(handler)).json()).toMatchObject({
      state: "unavailable",
      reason: "backend_unsupported",
      fallback_facts: null,
      stale: false,
    });
    expect(requestNow).not.toHaveBeenCalled();
    expect(listFacts).not.toHaveBeenCalled();
  });

  it("backend_unsupported (thrown typed error): same answer, and generation is NOT queued", async () => {
    const { handler, requestNow } = getSetup({
      list: async () => {
        throw new MemoryCapabilityError("backend_unsupported");
      },
    });
    expect((await get(handler)).json()).toMatchObject({
      state: "unavailable",
      reason: "backend_unsupported",
      fallback_facts: null,
    });
    expect(requestNow).not.toHaveBeenCalled();
  });

  it("a store read failure is unavailable store_error with no fallback (never a 5xx shape change)", async () => {
    const { handler, store } = getSetup();
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("db"));
    const x = await get(handler);
    expect(x.out.status).toBe(200);
    expect(x.json()).toMatchObject({
      state: "unavailable",
      reason: "store_error",
      fallback_facts: null,
    });
  });

  it("users never cross: B sees only B's group", async () => {
    const { handler, store, listFacts } = getSetup();
    await store.claimOnDemand("ok_user_A", 3);
    await store.put("ok_user_A", { state: "ready", payload: [hl("a")] }, await store.clock());
    const b = await get(handler, B);
    expect(b.json().state).toBe("unavailable");
    expect((b.json().fallback_facts as Array<{ fact_id: string }>).map((f) => f.fact_id)).toEqual([
      "b_1",
    ]);
    expect(listFacts.mock.calls.every((c) => c[0] === "ok_user_B")).toBe(true);
  });
});

// ---- remove -------------------------------------------------------------------

const ID = `hl_${"a".repeat(24)}`;

function removeSetup(over: Partial<RemoveRouteDeps> = {}) {
  let now = 1_000_000;
  const run = vi.fn(
    async (): Promise<RemoveResult> => ({
      status: "SUCCEEDED",
      retryable: false,
      reasons: [],
      removed_facts: 2,
    }),
  );
  const deps: RemoveRouteDeps = {
    ...auth,
    remove: { groupFor, run },
    now: () => now,
    ...over,
  };
  return { run, handler: createRemoveHighlightHandler(deps), tick: (ms: number) => (now += ms) };
}

async function post(
  handler: ReturnType<typeof createRemoveHighlightHandler>,
  body: unknown,
  headers = A,
) {
  const x = res();
  await handler(req("POST", headers, typeof body === "string" ? body : JSON.stringify(body)), x.r);
  return x;
}

describe("POST /gateway/memory/highlights/remove", () => {
  it("405 / 401", async () => {
    const { handler } = removeSetup();
    const g = res();
    await handler(req("GET", A), g.r);
    expect(g.out.status).toBe(405);
    expect(
      (await post(handler, { highlight_id: ID }, { authorization: "Bearer nope" })).out.status,
    ).toBe(401);
  });

  it("removes in the caller's own group and returns the contract shape", async () => {
    const { handler, run } = removeSetup();
    const x = await post(handler, { highlight_id: ID });
    expect(x.json()).toEqual({
      contract: HIGHLIGHTS_CONTRACT,
      status: "SUCCEEDED",
      retryable: false,
      reasons: [],
      removed_facts: 2,
    });
    expect(run).toHaveBeenCalledWith("ok_user_A", ID);
  });

  it("a malformed or missing id is not_found (idempotent success), with no store work", async () => {
    const { handler, run } = removeSetup();
    for (const body of [
      {},
      { highlight_id: "e_1" },
      { highlight_id: 7 },
      "not json",
      { highlight_id: `${ID}x` },
    ]) {
      expect((await post(handler, body)).json()).toMatchObject({
        status: "SUCCEEDED",
        reasons: ["not_found"],
        removed_facts: 0,
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("an oversized body is refused without reading it all", async () => {
    const { handler, run } = removeSetup();
    const x = await post(handler, `{"highlight_id":"${ID}","pad":"${"x".repeat(10_000)}"}`);
    expect(x.out.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it("single-flight per user: a concurrent second call is in_progress", async () => {
    let release!: () => void;
    const { handler } = removeSetup({
      remove: {
        groupFor,
        run: () =>
          new Promise<RemoveResult>((r) => {
            release = () =>
              r({ status: "SUCCEEDED", retryable: false, reasons: [], removed_facts: 1 });
          }),
      },
    });
    const first = post(handler, { highlight_id: ID });
    await new Promise((r) => setTimeout(r, 0));
    const second = await post(handler, { highlight_id: ID });
    expect(second.json()).toMatchObject({
      status: "FAILED",
      retryable: true,
      reasons: ["in_progress"],
    });
    release();
    expect((await first).json().status).toBe("SUCCEEDED");
  });

  it("5 s cooldown per user: rate_limited inside it; another user is unaffected", async () => {
    const { handler, tick } = removeSetup();
    await post(handler, { highlight_id: ID });
    tick(4_000);
    expect((await post(handler, { highlight_id: ID })).json()).toMatchObject({
      reasons: ["rate_limited"],
      retryable: true,
    });
    expect((await post(handler, { highlight_id: ID }, B)).json().status).toBe("SUCCEEDED");
    tick(1_001);
    expect((await post(handler, { highlight_id: ID })).json().status).toBe("SUCCEEDED");
  });

  it("not enabled: FAILED misconfigured, not retryable", async () => {
    const { handler } = removeSetup({ remove: null });
    expect((await post(handler, { highlight_id: ID })).json()).toMatchObject({
      status: "FAILED",
      retryable: false,
      reasons: ["misconfigured"],
    });
  });

  it("an unexpected throw is FAILED store_error retryable", async () => {
    const { handler } = removeSetup({
      remove: {
        groupFor,
        run: async () => {
          throw new Error("boom");
        },
      },
    });
    expect((await post(handler, { highlight_id: ID })).json()).toMatchObject({
      status: "FAILED",
      retryable: true,
      reasons: ["store_error"],
    });
  });
});
