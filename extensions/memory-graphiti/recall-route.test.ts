/**
 * GET /gateway/memory/recall (A&D §1c): the facts injected into ONE turn, for the
 * verified Clerk user only. The same auth as POST /gateway/memory/forget; another
 * user's turn id answers `none` (never 403), so turn ids cannot be probed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createRecallHandler,
  RECALL_CONTRACT,
  RECALL_ROUTE_PATH,
  type RecallRouteDeps,
} from "./recall-route.js";
import type { RecallItem, RecallRecord, RecallStore } from "./recall-store.js";

const CLERK = { issuer: "i" } as unknown as NonNullable<
  ReturnType<RecallRouteDeps["resolveClerk"]>
>;
const SUB_A = "user_2AAAAAAAAAAAAAAAAAAAAAAAAA";
const SUB_B = "user_2BBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKENS: Record<string, string> = { "token-a": SUB_A, "token-b": SUB_B };
const groupFor = (sub: string) => `ok_${sub.toLowerCase()}`;

const ITEMS_A: RecallItem[] = [
  { rank: 1, fact_id: "e_a1", fact: "A sleeps late", last_seen: "2026-10-20" },
  { rank: 2, fact_id: "e_a2", fact: "A drinks espresso", last_seen: null },
];

/** A group-keyed in-memory store (storage itself is tested in recall-store.*). */
function memoryStore(): RecallStore & { rows: Map<string, RecallRecord> } {
  const rows = new Map<string, RecallRecord>();
  const k = (g: string, t: string) => `${g}\u0000${t}`;
  return {
    rows,
    async write(g, t, items, state) {
      rows.set(k(g, t), { turnId: t, items, state, at: new Date(rows.size).toISOString() });
    },
    async read(g, t) {
      return rows.get(k(g, t)) ?? null;
    },
    async latest(g) {
      const mine = [...rows.entries()].filter(([key]) => key.startsWith(`${g}\u0000`));
      return mine.at(-1)?.[1] ?? null;
    },
    async deleteGroup() {
      return 0;
    },
    async forgetGroup() {
      return 0;
    },
    async deleteCitingFacts() {
      return 0;
    },
  };
}

function call(
  handler: ReturnType<typeof createRecallHandler>,
  init: { method?: string; headers?: Record<string, string>; url?: string } = {},
) {
  const req = {
    method: init.method ?? "GET",
    url: init.url ?? RECALL_ROUTE_PATH,
    headers: init.headers ?? { authorization: "Bearer token-a" },
  } as unknown as IncomingMessage;
  let status = 0;
  let headers: Record<string, string> = {};
  let body = "";
  const res = {
    writeHead: (s: number, h: Record<string, string>) => {
      status = s;
      headers = h ?? {};
    },
    end: (b: string) => {
      body = b;
    },
  } as unknown as ServerResponse;
  return handler(req, res).then(() => ({
    status,
    headers,
    raw: body,
    json: body ? JSON.parse(body) : null,
  }));
}

async function deps(over: Partial<RecallRouteDeps> = {}) {
  const store = memoryStore();
  await store.write(groupFor(SUB_A), "resp_a_1", ITEMS_A.slice(0, 1), "ready");
  await store.write(groupFor(SUB_A), "resp_a_2", ITEMS_A, "ready");
  await store.write(groupFor(SUB_B), "resp_b_1", [], "timed_out");
  const d: RecallRouteDeps = {
    resolveClerk: () => CLERK,
    verifyJwt: async (t) => (TOKENS[t] ? { ok: true, externalId: TOKENS[t] } : { ok: false }),
    recall: { store, groupFor },
    ...over,
  };
  return { d, store };
}

describe("GET /gateway/memory/recall — method and auth", () => {
  it("405 for anything but GET", async () => {
    const { d } = await deps();
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await call(createRecallHandler(d), { method })).status).toBe(405);
    }
  });

  it.each([
    ["no bearer", { headers: {} }, {}],
    ["an invalid token", { headers: { authorization: "Bearer nope" } }, {}],
    ["Clerk not configured", {}, { resolveClerk: () => undefined }],
    [
      "the verifier throws",
      {},
      {
        verifyJwt: async () => {
          throw new Error("jwks down");
        },
      },
    ],
    ["a revoked session", {}, { validateSession: async () => false }],
  ])("401 with %s, and no record is read", async (_l, init, over) => {
    const { d, store } = await deps(over as Partial<RecallRouteDeps>);
    const read = vi.spyOn(store, "read");
    const latest = vi.spyOn(store, "latest");
    const r = await call(createRecallHandler(d), init);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
    expect(read).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();
  });

  it("passes the session-id header and the token's sub to the session check", async () => {
    const validateSession = vi.fn(async () => true);
    const { d } = await deps({ validateSession });
    await call(createRecallHandler(d), {
      headers: { authorization: "Bearer token-a", "x-openclaw-clerk-session-id": "sess_1" },
    });
    expect(validateSession).toHaveBeenCalledWith(SUB_A, "sess_1");
  });
});

describe("GET /gateway/memory/recall — contract", () => {
  it("ready: the stored items in rank order, with highlight_id null, no-store", async () => {
    const { d } = await deps();
    const r = await call(createRecallHandler(d), { url: `${RECALL_ROUTE_PATH}?turn=resp_a_2` });
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.json).toEqual({
      contract: RECALL_CONTRACT,
      state: "ready",
      turn: "resp_a_2",
      items: ITEMS_A.map((i) => ({ ...i, highlight_id: null })),
    });
    // key order is part of the contract
    expect(r.raw).toContain(
      '{"rank":1,"fact_id":"e_a1","fact":"A sleeps late","last_seen":"2026-10-20","highlight_id":null}',
    );
  });

  it("turn omitted: this user's latest turn", async () => {
    const { d } = await deps();
    const r = await call(createRecallHandler(d));
    expect(r.json).toMatchObject({ state: "ready", turn: "resp_a_2" });
    expect(r.json.items).toHaveLength(2);
  });

  it("A/B never cross: B asking for A's turn id gets none (not 403); each sees only its own", async () => {
    const { d } = await deps();
    const h = createRecallHandler(d);
    const bOnA = await call(h, {
      url: `${RECALL_ROUTE_PATH}?turn=resp_a_2`,
      headers: { authorization: "Bearer token-b" },
    });
    expect(bOnA.status).toBe(200);
    expect(bOnA.json).toEqual({
      contract: RECALL_CONTRACT,
      state: "none",
      turn: "resp_a_2",
      items: [],
    });
    const bLatest = await call(h, { headers: { authorization: "Bearer token-b" } });
    expect(bLatest.json).toMatchObject({ state: "timed_out", turn: "resp_b_1", items: [] });
    const aOnB = await call(h, { url: `${RECALL_ROUTE_PATH}?turn=resp_b_1` });
    expect(aOnB.json.state).toBe("none");
  });

  it("the user is ONLY the token's sub — caller-supplied ids are never read", async () => {
    const { d } = await deps();
    const r = await call(createRecallHandler(d), {
      url: `${RECALL_ROUTE_PATH}?turn=resp_a_2&userId=${SUB_B}&group=${groupFor(SUB_B)}`,
      headers: { authorization: "Bearer token-b", "x-openclaw-user": SUB_A },
    });
    expect(r.json.state).toBe("none");
  });

  it("unknown turn: none", async () => {
    const { d } = await deps();
    const r = await call(createRecallHandler(d), { url: `${RECALL_ROUTE_PATH}?turn=resp_nope` });
    expect(r.json).toEqual({
      contract: RECALL_CONTRACT,
      state: "none",
      turn: "resp_nope",
      items: [],
    });
  });

  it("a user with no record and no turn: none with a null turn", async () => {
    const { d } = await deps({
      verifyJwt: async () => ({ ok: true, externalId: "user_2CCCCCCCCCCCCCCCCCCCCCCCCC" }),
    });
    const r = await call(createRecallHandler(d));
    expect(r.json).toEqual({ contract: RECALL_CONTRACT, state: "none", turn: null, items: [] });
  });

  it("not_enabled (memory refused or off): answered AFTER auth, never touches a store", async () => {
    const { d } = await deps({ recall: null });
    const ok = await call(createRecallHandler(d), { url: `${RECALL_ROUTE_PATH}?turn=resp_a_2` });
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.json).toEqual({
      contract: RECALL_CONTRACT,
      state: "not_enabled",
      turn: "resp_a_2",
      items: [],
    });
    const unauth = await call(createRecallHandler(d), { headers: {} });
    expect(unauth.status).toBe(401); // auth still first
  });

  it("a store failure is a 503, never a 'none' that reads as 'nothing was recalled'", async () => {
    const { d, store } = await deps();
    vi.spyOn(store, "read").mockRejectedValue(new Error("db down"));
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const r = await call(createRecallHandler({ ...d, logger }), {
      url: `${RECALL_ROUTE_PATH}?turn=resp_a_2`,
    });
    expect(r.status).toBe(503);
    expect(r.json).toEqual({ contract: RECALL_CONTRACT, error: "unavailable" });
    const logged = logger.error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(SUB_A);
    expect(logged).not.toContain(groupFor(SUB_A));
  });

  it("an over-long turn id is treated as unknown without a lookup", async () => {
    const { d, store } = await deps();
    const read = vi.spyOn(store, "read");
    const r = await call(createRecallHandler(d), {
      url: `${RECALL_ROUTE_PATH}?turn=${"x".repeat(300)}`,
    });
    expect(r.json.state).toBe("none");
    expect(r.json.turn).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("GET /gateway/memory/recall — highlight_id join (PR-2)", () => {
  it("each item carries the id of the cached highlight that cites its fact, else null", async () => {
    const { d } = await deps();
    const index = vi.fn(async (g: string) =>
      g === groupFor(SUB_A) ? new Map([["e_a2", "hl_espresso"]]) : new Map<string, string>(),
    );
    const r = await call(
      createRecallHandler({ ...d, recall: { ...d.recall!, highlightIndex: index } }),
      { url: `${RECALL_ROUTE_PATH}?turn=resp_a_2` },
    );
    expect(
      (r.json as { items: Array<{ highlight_id: string | null }> }).items.map(
        (i) => i.highlight_id,
      ),
    ).toEqual([null, "hl_espresso"]);
    expect(index).toHaveBeenCalledWith(groupFor(SUB_A));
  });

  it("a highlight index failure never fails the recall route: highlight_id null", async () => {
    const { d } = await deps();
    const r = await call(
      createRecallHandler({
        ...d,
        recall: {
          ...d.recall!,
          highlightIndex: async () => {
            throw new Error("db");
          },
        },
      }),
      { url: `${RECALL_ROUTE_PATH}?turn=resp_a_2` },
    );
    expect(r.status).toBe(200);
    expect(
      (r.json as { items: Array<{ highlight_id: unknown }> }).items.every(
        (i) => i.highlight_id === null,
      ),
    ).toBe(true);
  });
});
