/**
 * One group's regeneration (A&D §4.4): list the group's facts, generate, store.
 * A failed run never replaces highlights the user already had.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryCapabilityError, type ListFactsResult, type MemoryFact } from "../client.js";
import { FakeHighlightStore } from "../testing/fake-highlight-store.js";
import type { GenerateResult } from "./generate.js";
import { LIST_PAGES_MAX, regenerateGroup } from "./regenerate.js";
import type { Highlight } from "./types.js";

const G = "ok_g";
const fact = (id: string): MemoryFact => ({
  id,
  fact: `fact ${id}`,
  name: "R",
  validAt: null,
  invalidAt: null,
  createdAt: "2026-10-20T00:00:00Z",
  expiredAt: null,
  episodeIds: [],
});
const hl = (id: string): Highlight => ({
  id,
  category: "sleep",
  title: "t",
  body: "b.",
  first_seen: "2026-10-20",
  last_seen: "2026-10-20",
  occurrences: 1,
  recurring: false,
  score: 1,
  sources: [{ fact_id: "e_1", fact: "fact e_1", last_seen: "2026-10-20" }],
});
const DROPPED = { schema: 0, category: 0, shape: 0, ref: 0, guard: 0 };
const READY = (id = "hl_1"): GenerateResult => ({
  state: "ready",
  highlights: [hl(id)],
  dropped: DROPPED,
});
const UNAVAILABLE: GenerateResult = {
  state: "unavailable",
  reason: "summariser_error",
  fallback_facts: [],
  dropped: DROPPED,
};

function setup(pages: MemoryFact[][] = [[fact("e_1")]]) {
  const store = new FakeHighlightStore();
  const listFacts = vi.fn(
    async (_g: string, opts?: { cursor?: string }): Promise<ListFactsResult> => {
      const i = opts?.cursor ? Number(opts.cursor) : 0;
      return { facts: pages[i] ?? [], nextCursor: i + 1 < pages.length ? String(i + 1) : null };
    },
  );
  const generate = vi.fn(async (_facts: MemoryFact[]): Promise<GenerateResult> => READY());
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps = { client: { listFacts }, store, generate, logger };
  return { store, listFacts, generate, logger, deps };
}

describe("regenerateGroup", () => {
  it("a group with no row is not generated (gone): no listing, no model", async () => {
    const { deps, listFacts, generate } = setup();
    expect(await regenerateGroup(G, deps)).toBe("gone");
    expect(listFacts).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("ready: stores the highlights and clears the stale mark", async () => {
    const { deps, store } = setup();
    await store.claimOnDemand(G, 3);
    await store.markStale(G);
    expect(await regenerateGroup(G, deps)).toBe("ready");
    expect(await store.get(G)).toMatchObject({ state: "ready", staleSince: null });
    expect((await store.get(G))?.payload.map((h) => h.id)).toEqual(["hl_1"]);
  });

  it("lists every page (invalidated excluded by the generator), within the page cap", async () => {
    const { deps, store, listFacts, generate } = setup([[fact("a")], [fact("b")], [fact("c")]]);
    await store.claimOnDemand(G, 3);
    await regenerateGroup(G, deps);
    expect(generate.mock.calls[0][0].map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(listFacts.mock.calls[0][1]).toMatchObject({ includeInvalid: false });

    const many = setup(Array.from({ length: LIST_PAGES_MAX + 3 }, (_, i) => [fact(`p${i}`)]));
    await many.store.claimOnDemand(G, 3);
    await regenerateGroup(G, many.deps);
    expect(many.listFacts).toHaveBeenCalledTimes(LIST_PAGES_MAX);
  });

  it("a failed run keeps the highlights the user already had, and stays stale for a retry", async () => {
    const { deps, store, generate } = setup();
    await store.claimOnDemand(G, 3);
    await store.put(G, { state: "ready", payload: [hl("hl_old")] }, await store.clock());
    await store.markStale(G);
    generate.mockResolvedValueOnce(UNAVAILABLE);
    expect(await regenerateGroup(G, deps)).toBe("kept_previous");
    const row = await store.get(G);
    expect(row?.payload.map((h) => h.id)).toEqual(["hl_old"]);
    expect(row?.staleSince).not.toBeNull();
  });

  it("a failed first run (placeholder row) is stored as unavailable", async () => {
    const { deps, store, generate } = setup();
    await store.claimOnDemand(G, 3);
    generate.mockResolvedValueOnce(UNAVAILABLE);
    expect(await regenerateGroup(G, deps)).toBe("unavailable");
    expect((await store.get(G))?.state).toBe("unavailable");
  });

  it("empty: zero facts is stored as empty", async () => {
    const { deps, store, generate } = setup([[]]);
    await store.claimOnDemand(G, 3);
    generate.mockResolvedValueOnce({ state: "empty", highlights: [], dropped: DROPPED });
    expect(await regenerateGroup(G, deps)).toBe("empty");
    expect(await store.get(G)).toMatchObject({ state: "empty", payload: [] });
  });

  it("a backend that cannot list facts: backend_unsupported, nothing generated or written", async () => {
    const { deps, store, listFacts, generate } = setup();
    await store.claimOnDemand(G, 3);
    listFacts.mockRejectedValueOnce(new MemoryCapabilityError("backend_unsupported"));
    expect(await regenerateGroup(G, deps)).toBe("backend_unsupported");
    expect(generate).not.toHaveBeenCalled();
    expect((await store.get(G))?.state).toBe("unavailable");
  });

  it("a listing error: error, nothing generated or written, the stale mark kept", async () => {
    const { deps, store, listFacts, generate, logger } = setup();
    await store.claimOnDemand(G, 3);
    await store.markStale(G);
    listFacts.mockRejectedValueOnce(new Error("zep 503 for ok_g"));
    expect(await regenerateGroup(G, deps)).toBe("error");
    expect(generate).not.toHaveBeenCalled();
    expect((await store.get(G))?.staleSince).not.toBeNull();
    // Logs carry no group id and no error text that might.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("ok_g");
  });

  it("a forget that deletes the row mid-run wins: nothing is re-created (gone)", async () => {
    const { deps, store, generate } = setup();
    await store.claimOnDemand(G, 3);
    generate.mockImplementationOnce(async () => {
      await store.deleteGroup(G);
      return READY();
    });
    expect(await regenerateGroup(G, deps)).toBe("gone");
    expect(await store.get(G)).toBeNull();
  });
});
