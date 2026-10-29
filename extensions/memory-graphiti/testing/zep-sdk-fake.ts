/**
 * A stand-in for the @getzep/zep-cloud SDK object inside ZepCloudClient, so the
 * adapter runs against recorded-shape fixtures and never the network. Shapes
 * follow @getzep/zep-cloud 3.18.0 (EntityEdge, GraphSearchResults, GraphEdgesRequest).
 */
import { vi } from "vitest";
import type { MemoryFact } from "../client.js";

/** EntityEdge as the SDK returns it (camelCase, optional fields absent, not null). */
export type SdkEdge = {
  uuid: string;
  fact: string;
  name: string;
  createdAt: string;
  validAt?: string;
  invalidAt?: string;
  expiredAt?: string;
  episodes?: string[];
  score?: number;
  sourceNodeUuid: string;
  targetNodeUuid: string;
};

export function toSdkEdge(f: MemoryFact, score?: number): SdkEdge {
  return {
    uuid: f.id,
    fact: f.fact,
    name: f.name,
    createdAt: f.createdAt,
    ...(f.validAt ? { validAt: f.validAt } : {}),
    ...(f.invalidAt ? { invalidAt: f.invalidAt } : {}),
    ...(f.expiredAt ? { expiredAt: f.expiredAt } : {}),
    ...(f.episodeIds.length ? { episodes: f.episodeIds } : {}),
    ...(score !== undefined ? { score } : {}),
    sourceNodeUuid: `n_src_${f.id}`,
    targetNodeUuid: `n_tgt_${f.id}`,
  };
}

const notFound = () => Object.assign(new Error("Not found"), { statusCode: 404 });

const tokens = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/**
 * An in-memory Zep "server" behind the SDK's method shapes:
 *   - graph.edge.getByUserId(userId, {limit, uuidCursor}) → a bare EntityEdge[] page
 *     (no next cursor; the caller passes the last uuid back);
 *   - graph.edge.delete(uuid) → 404 when absent;
 *   - graph.search({userId, query, scope:"edges", limit, ...}, requestOptions)
 *     → {edges} ranked by token overlap, or `searchResult` when set (a recording).
 */
export function createZepSdkFake() {
  const users = new Map<string, SdkEdge[]>();
  const state: { searchResult: SdkEdge[] | null } = { searchResult: null };
  const zep = {
    user: { add: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) },
    graph: {
      add: vi.fn(async () => ({ uuid: "ep-1" })),
      episode: { get: vi.fn(), getByUserId: vi.fn(async () => ({ episodes: [] })) },
      edge: {
        getByUserId: vi.fn(
          async (userId: string, req: { limit?: number; uuidCursor?: string } = {}) => {
            const all = users.get(userId) ?? [];
            const start = req.uuidCursor ? all.findIndex((e) => e.uuid === req.uuidCursor) + 1 : 0;
            return structuredClone(all.slice(start, start + (req.limit ?? 100)));
          },
        ),
        delete: vi.fn(async (uuid: string) => {
          for (const edges of users.values()) {
            const i = edges.findIndex((e) => e.uuid === uuid);
            if (i >= 0) {
              edges.splice(i, 1);
              return { message: "deleted" };
            }
          }
          throw notFound();
        }),
      },
      search: vi.fn(
        async (
          req: { userId?: string; query: string; limit?: number; scope?: string },
          _opts?: { abortSignal?: AbortSignal },
        ) => {
          if (state.searchResult) {
            return { edges: structuredClone(state.searchResult) };
          }
          const q = tokens(req.query);
          const edges = (users.get(req.userId ?? "") ?? [])
            .filter((e) => !e.invalidAt && !e.expiredAt)
            .map((e) => ({ e, n: [...q].filter((t) => tokens(e.fact).has(t)).length }))
            .filter((x) => x.n > 0)
            .toSorted((a, b) => b.n - a.n || Date.parse(b.e.createdAt) - Date.parse(a.e.createdAt))
            .slice(0, req.limit ?? 10)
            .map((x, i) => ({ ...structuredClone(x.e), score: 1 / (i + 1) }));
          return { edges };
        },
      ),
    },
  };
  return {
    zep,
    state,
    seed: (userId: string, facts: MemoryFact[]): void => {
      users.set(userId, [...(users.get(userId) ?? []), ...facts.map((f) => toSdkEdge(f))]);
    },
  };
}

/** Swap the SDK object inside a constructed ZepCloudClient. */
export function attachSdk(client: object, zep: unknown): void {
  Object.defineProperty(client, "zep", { value: zep });
}
