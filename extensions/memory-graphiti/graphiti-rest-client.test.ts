/**
 * GraphitiRestClient fact surface (CTO #17028 option (b)), over an HTTP fixture
 * of graphiti-server: /search has no reranker and no score, DELETE
 * /entity-edge/{uuid} exists, and facts are listed through our overlay's paged
 * GET /groups/{group_id}/entity-edges (mono #598).
 */
import { describe, expect, it, vi } from "vitest";
import { GraphitiRestClient, MemoryCapabilityError } from "./client.js";
import { createGraphitiServerFake } from "./testing/graphiti-server-fake.js";
import { factFixture } from "./testing/memory-client.contract.js";

const G = "ok_rest_group";

function rest() {
  const server = createGraphitiServerFake();
  const client = new GraphitiRestClient(server.base, { fetch: server.fetch });
  return { client, ...server };
}

const topic = factFixture(9, { fact: "espresso late at night", episodeIds: ["ep_a", "ep_b"] });

describe("GraphitiRestClient.searchRanked", () => {
  it("POST /search {group_ids:[group], query, max_facts}; server order; score null", async () => {
    const { client, fetchImpl, seed, base } = rest();
    seed(G, [topic]);
    const r = await client.searchRanked(G, "espresso", { reranker: "rrf", limit: 6 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`${base}/search`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      group_ids: [G],
      query: "espresso",
      max_facts: 6,
    });
    expect(r).toEqual([{ ...topic, rank: 1, score: null }]);
  });

  it("a non-rrf reranker is not silently honoured: rerankerApplied = server_default", async () => {
    const { client, seed, fetchImpl } = rest();
    seed(G, [topic]);
    const r = await client.searchRanked(G, "espresso", { reranker: "cross_encoder", limit: 6 });
    expect(r[0]).toMatchObject({ rerankerApplied: "server_default", score: null });
    // nothing reranker-shaped is sent: the server has no such parameter
    expect(Object.keys(JSON.parse(fetchImpl.mock.calls[0][1]?.body as string))).toEqual([
      "group_ids",
      "query",
      "max_facts",
    ]);
  });

  it("keeps the server's order (no re-sort)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            facts: [3, 1, 2].map((i) => ({
              uuid: `e_${i}`,
              name: "R",
              fact: `f${i}`,
              valid_at: null,
              invalid_at: null,
              created_at: "2026-10-01T00:00:00Z",
              expired_at: null,
            })),
          }),
          { status: 200 },
        ),
    );
    const client = new GraphitiRestClient("http://g.test", { fetch: fetchImpl });
    const r = await client.searchRanked(G, "q", { reranker: "rrf", limit: 3 });
    expect(r.map((x) => [x.id, x.rank, x.episodeIds])).toEqual([
      ["e_3", 1, []],
      ["e_1", 2, []],
      ["e_2", 3, []],
    ]);
  });

  it("an aborted signal aborts the request", async () => {
    const { client, seed } = rest();
    seed(G, [topic]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      client.searchRanked(G, "espresso", { reranker: "rrf", limit: 5, signal: ac.signal }),
    ).rejects.toThrow();
  });

  it("a server error propagates", async () => {
    const client = new GraphitiRestClient("http://g.test", {
      fetch: vi.fn(async () => new Response("boom", { status: 500 })),
    });
    await expect(client.searchRanked(G, "q", { reranker: "rrf", limit: 3 })).rejects.toThrow(
      "POST /search failed (500)",
    );
  });
});

describe("GraphitiRestClient.forgetFacts", () => {
  it("DELETE /entity-edge/{uuid}: 200 = deleted, 404 = absent", async () => {
    const { client, seed, fetchImpl, base } = rest();
    seed(G, [topic]);
    expect(await client.forgetFacts(G, [topic.id, "e_missing"])).toEqual({
      deleted: 1,
      absent: 1,
    });
    expect(fetchImpl.mock.calls.map(([u, i]) => [i?.method, String(u)])).toEqual([
      ["DELETE", `${base}/entity-edge/${topic.id}`],
      ["DELETE", `${base}/entity-edge/e_missing`],
    ]);
  });

  it("the uuid is path-encoded", async () => {
    const { client, fetchImpl, base } = rest();
    await client.forgetFacts(G, ["a/b?c"]);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(`${base}/entity-edge/a%2Fb%3Fc`);
  });

  it("any other status throws (retry is idempotent)", async () => {
    const client = new GraphitiRestClient("http://g.test", {
      fetch: vi.fn(async () => new Response("", { status: 503 })),
    });
    await expect(client.forgetFacts(G, ["e_1"])).rejects.toThrow(
      "DELETE /entity-edge failed (503)",
    );
  });
});

describe("GraphitiRestClient.listFacts / capabilities", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => factFixture(i + 1));

  it("GET /groups/{group}/entity-edges?limit=50, the group id URL-encoded, no body", async () => {
    const { client, fetchImpl, seed, base } = rest();
    seed("ok/odd group", [factFixture(1)]);
    await client.listFacts("ok/odd group");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(`${base}/groups/ok%2Fodd%20group/entity-edges?limit=50`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("RED: a group larger than one page is read COMPLETELY (a stop-after-page-1 client fails)", async () => {
    const { client, seed, fetchImpl } = rest();
    seed(G, many(130));
    const r = await client.listFacts(G);
    expect(new Set(r.facts.map((f) => f.id)).size).toBe(130);
    expect(r.nextCursor).toBeNull();
    expect(r.truncated).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 50 + 50 + 30
  });

  it("an exact multiple of the page and an empty group both end with a null cursor", async () => {
    const a = rest();
    a.seed(G, many(100));
    const r = await a.client.listFacts(G);
    expect(r.facts).toHaveLength(100);
    expect(r.nextCursor).toBeNull();
    const b = rest();
    expect(await b.client.listFacts(G)).toEqual({ facts: [], nextCursor: null });
  });

  it("stops at the 2000-fact ceiling: truncated, with a cursor that continues to the rest", async () => {
    const { client, seed } = rest();
    seed(G, many(2_030));
    const first = await client.listFacts(G);
    expect(first.facts).toHaveLength(2_000);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const rest2 = await client.listFacts(G, { cursor: first.nextCursor ?? undefined });
    expect(rest2.facts).toHaveLength(30);
    expect(rest2.nextCursor).toBeNull();
    const all = new Set([...first.facts, ...rest2.facts].map((f) => f.id));
    expect(all.size).toBe(2_030);
  });

  it("invalid facts are filtered AFTER paging, so a page of only invalid facts does not end the read", async () => {
    const { client, seed } = rest();
    // uuid DESC order: e_0100..e_0051 come first (all invalid), then the valid ones.
    seed(G, [
      ...many(50),
      ...Array.from({ length: 50 }, (_, i) =>
        factFixture(i + 51, { invalidAt: "2026-10-01T00:00:00Z" }),
      ),
    ]);
    const r = await client.listFacts(G);
    expect(r.facts).toHaveLength(50);
    expect(r.facts.every((f) => f.invalidAt === null)).toBe(true);
    expect(r.nextCursor).toBeNull();
  });

  it("a server error is an error, never an empty list", async () => {
    const client = new GraphitiRestClient("http://g.test", {
      fetch: vi.fn(async () => new Response("boom", { status: 500 })),
    });
    await expect(client.listFacts(G)).rejects.toThrow("entity-edges failed (500)");
  });

  it("a server image without the route (404/405) is backend_unsupported, as before the overlay", async () => {
    for (const status of [404, 405]) {
      const noRoute = new GraphitiRestClient("http://g.test", {
        fetch: vi.fn(async () => new Response('{"detail":"Not Found"}', { status })),
      });
      const err = await noRoute.listFacts(G).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MemoryCapabilityError);
      expect((err as MemoryCapabilityError).reason).toBe("backend_unsupported");
    }
  });

  it("a non-positive or NaN limit is an error, never an empty list that looks complete", async () => {
    const { client, seed } = rest();
    seed(G, many(3));
    for (const limit of [0, -1, Number.NaN]) {
      await expect(client.listFacts(G, { limit })).rejects.toThrow(RangeError);
    }
  });

  it("the ceiling read takes exactly 40 pages", async () => {
    const { client, seed, fetchImpl } = rest();
    seed(G, many(2_030));
    await client.listFacts(G);
    expect(fetchImpl).toHaveBeenCalledTimes(40);
  });

  it("a reply that breaks the paging contract is an error (no loop, no silent partial list)", async () => {
    const reply = (body: unknown) =>
      new GraphitiRestClient("http://g.test", {
        fetch: vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      });
    const one = { uuid: "e_1", name: "n", fact: "f", created_at: "2026-10-01T00:00:00Z" };
    await expect(reply({ facts: [], next_cursor: "e_1" }).listFacts(G)).rejects.toThrow(
      "paging contract",
    );
    await expect(
      reply({ facts: [one], next_cursor: "e_1" }).listFacts(G, { cursor: "e_1" }),
    ).rejects.toThrow("paging contract");
    await expect(reply({ next_cursor: null }).listFacts(G)).rejects.toThrow("no facts array");
    const two = (a: string, b: string, next: string | null) => ({
      facts: [
        { ...one, uuid: a },
        { ...one, uuid: b },
      ],
      next_cursor: next,
    });
    // A cursor past the page (e.g. the limit+1 probe row) would skip a fact per page:
    // page 2 is well-formed below the bad cursor, so only the cursor check catches it.
    const pages = [
      two("e_9", "e_8", "e_7"),
      { facts: [{ ...one, uuid: "e_6" }], next_cursor: null },
    ];
    const skipping = new GraphitiRestClient("http://g.test", {
      fetch: vi.fn(async () => new Response(JSON.stringify(pages.shift()), { status: 200 })),
    });
    await expect(skipping.listFacts(G)).rejects.toThrow("paging contract");
    // uuids out of order, or not below the incoming cursor, would duplicate or skip.
    await expect(reply(two("e_8", "e_9", null)).listFacts(G)).rejects.toThrow("paging contract");
    await expect(reply(two("e_9", "e_8", null)).listFacts(G, { cursor: "e_5" })).rejects.toThrow(
      "paging contract",
    );
    await expect(
      reply({ facts: [{ ...one, uuid: undefined }], next_cursor: null }).listFacts(G),
    ).rejects.toThrow("paging contract");
  });

  it("an empty cursor reads from the start (never sends `cursor=`)", async () => {
    const { client, seed, fetchImpl } = rest();
    seed(G, many(3));
    const r = await client.listFacts(G, { cursor: "" });
    expect(r.facts).toHaveLength(3);
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("cursor=");
  });

  it("declares what it can do", () => {
    expect(rest().client.capabilities()).toEqual({
      listFacts: true,
      forgetFacts: true,
      rerankers: ["rrf"],
      scores: false,
    });
  });
});
