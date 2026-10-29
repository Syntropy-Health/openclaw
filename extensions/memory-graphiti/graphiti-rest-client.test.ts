/**
 * GraphitiRestClient fact surface (CTO #17028 option (b)), over an HTTP fixture
 * of graphiti-server: /search has no reranker and no score, DELETE
 * /entity-edge/{uuid} exists, and there is no list-edges route (mono #598).
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
  it("listFacts throws the typed MemoryCapabilityError('backend_unsupported') without a request", async () => {
    const { client, fetchImpl } = rest();
    const err = await client.listFacts(G).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryCapabilityError);
    expect((err as MemoryCapabilityError).reason).toBe("backend_unsupported");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("declares what it can do", () => {
    expect(rest().client.capabilities()).toEqual({
      listFacts: false,
      forgetFacts: true,
      rerankers: ["rrf"],
      scores: false,
    });
  });
});
