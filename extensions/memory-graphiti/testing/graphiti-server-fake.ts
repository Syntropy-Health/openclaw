/**
 * An HTTP fixture for the self-hosted graphiti-server (upstream getzep/graphiti
 * `server/graph_service`, read at efc40d21b0af): a fetch stand-in serving the
 * routes the adapter uses. No network.
 *   POST   /search             {group_ids, query, max_facts} → {facts: FactResult[]}
 *                              (no reranker parameter, no score; library hybrid + RRF)
 *   DELETE /entity-edge/{uuid} → 200 {message} | 404
 */
import { vi } from "vitest";
import type { FactResult, MemoryFact } from "../client.js";

const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

function toFactResult(f: MemoryFact): FactResult {
  return {
    uuid: f.id,
    name: f.name,
    fact: f.fact,
    valid_at: f.validAt,
    invalid_at: f.invalidAt,
    created_at: f.createdAt,
    expired_at: f.expiredAt,
    episodes: f.episodeIds,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createGraphitiServerFake(base = "http://graphiti.test") {
  const groups = new Map<string, MemoryFact[]>();
  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    init.signal?.throwIfAborted();
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && url.pathname === "/search") {
      const body = JSON.parse(init.body as string) as {
        group_ids: string[] | null;
        query: string;
        max_facts: number;
      };
      const q = tokens(body.query);
      const facts = (body.group_ids ?? [])
        .flatMap((g) => groups.get(g) ?? [])
        .filter((f) => !f.invalidAt && !f.expiredAt)
        .map((f) => ({ f, n: [...q].filter((t) => tokens(f.fact).has(t)).length }))
        .filter((x) => x.n > 0)
        .toSorted((a, b) => b.n - a.n || Date.parse(b.f.createdAt) - Date.parse(a.f.createdAt))
        .slice(0, body.max_facts)
        .map((x) => toFactResult(x.f));
      return json(200, { facts });
    }
    const edge = url.pathname.match(/^\/entity-edge\/(.+)$/);
    if (method === "DELETE" && edge) {
      const uuid = decodeURIComponent(edge[1]);
      for (const facts of groups.values()) {
        const i = facts.findIndex((f) => f.id === uuid);
        if (i >= 0) {
          facts.splice(i, 1);
          return json(200, { message: "Entity Edge deleted", success: true });
        }
      }
      return json(404, { detail: "Entity edge not found" });
    }
    return json(404, { detail: "Not Found" });
  });
  return {
    base,
    /** Assertions read the calls here. */
    fetchImpl,
    /** Pass this as GraphitiRestClient's `fetch`. */
    fetch: fetchImpl as unknown as typeof fetch,
    seed: (groupId: string, facts: MemoryFact[]): void => {
      groups.set(groupId, [...(groups.get(groupId) ?? []), ...structuredClone(facts)]);
    },
  };
}
