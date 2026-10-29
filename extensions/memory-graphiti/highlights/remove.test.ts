/**
 * Remove one highlight (A&D §4.7, PLAN P6.2): its source facts are deleted from
 * the user's own graph, their source entries are tombstoned FIRST (so the live
 * session's replay never re-uploads them), every cached highlight and recall
 * record citing them goes, and the group is marked stale.
 */
import { describe, expect, it, vi } from "vitest";
import { captureWithReceipts } from "../capture.js";
import type { MemoryClient, MemoryFact } from "../client.js";
import { createMemoryReceiptLedger } from "../receipts.js";
import { FakeHighlightStore } from "../testing/fake-highlight-store.js";
import { removeHighlight, type RemoveDeps } from "./remove.js";
import type { Highlight } from "./types.js";

const G = "ok_a";
const fact = (id: string, episodeIds: string[]): MemoryFact => ({
  id,
  fact: `fact ${id}`,
  name: "R",
  validAt: null,
  invalidAt: null,
  createdAt: "2026-10-20T00:00:00Z",
  expiredAt: null,
  episodeIds,
});
const hl = (id: string, factIds: string[]): Highlight => ({
  id,
  category: "sleep",
  title: "t",
  body: "b.",
  first_seen: "2026-10-20",
  last_seen: "2026-10-20",
  occurrences: 1,
  recurring: false,
  score: 1,
  sources: factIds.map((f) => ({ fact_id: f, fact: `fact ${f}`, last_seen: "2026-10-20" })),
});

/** A store with global delete-by-id (Zep-like), per-group listing, and capture. */
function fakeBackend() {
  const graph = new Map<string, MemoryFact[]>();
  let n = 0;
  const submit = vi.fn(async () => ({ ref: `ep_${++n}` }));
  const client = {
    label: "fake",
    submit,
    confirm: vi.fn(async (_g: string, _i: unknown, sub: { ref: string }) => ({
      status: "confirmed" as const,
      episodeIds: [sub.ref],
    })),
    capabilities: () => ({ listFacts: true, forgetFacts: true, rerankers: ["rrf"], scores: false }),
    listFacts: vi.fn(async (g: string) => ({ facts: graph.get(g) ?? [], nextCursor: null })),
    searchRanked: async () => [],
    forgetFacts: vi.fn(async (_g: string, ids: string[]) => {
      let deleted = 0;
      for (const [k, fs] of graph) {
        const next = fs.filter((f) => !ids.includes(f.id));
        deleted += fs.length - next.length;
        graph.set(k, next);
      }
      return { deleted, absent: ids.length - deleted };
    }),
  };
  return { graph, client: client as unknown as MemoryClient & typeof client, submit };
}

async function setup() {
  const { graph, client, submit } = fakeBackend();
  const ledger = createMemoryReceiptLedger();
  const store = new FakeHighlightStore();
  const recall = { deleteCitingFacts: vi.fn(async () => 1) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deps: RemoveDeps = { store, client, ledger, recall, logger };
  // A live session turn, captured: receipts link its entries to episode ep_1.
  const messages = [
    { content: "I slept 5 hours", roleType: "user" as const },
    { content: "Noted", roleType: "assistant" as const },
  ];
  const first = await captureWithReceipts({
    client,
    ledger,
    groupId: G,
    messages,
    inFlight: new Set(),
  });
  expect(first.confirmed).toBe(2);
  graph.set(G, [fact("e_1", ["ep_1"]), fact("e_2", ["ep_old_untracked"]), fact("e_3", ["ep_9"])]);
  graph.set("ok_b", [fact("b_1", ["ep_b"])]);
  await store.claimOnDemand(G, 3);
  await store.put(
    G,
    {
      state: "ready",
      payload: [hl("hl_sleep", ["e_1", "e_2"]), hl("hl_other", ["e_3"]), hl("hl_shared", ["e_2"])],
    },
    await store.clock(),
  );
  return { graph, client, submit, ledger, store, recall, logger, deps, messages };
}

describe("removeHighlight", () => {
  it("deletes the sources, drops every highlight citing them, deletes citing recall rows, marks stale", async () => {
    const { deps, graph, store, recall } = await setup();
    const r = await removeHighlight(G, "hl_sleep", deps);
    expect(r).toEqual({ status: "SUCCEEDED", retryable: false, reasons: [], removed_facts: 2 });
    expect(graph.get(G)?.map((f) => f.id)).toEqual(["e_3"]);
    const row = await store.get(G);
    expect(row?.payload.map((h) => h.id)).toEqual(["hl_other"]); // hl_shared cited e_2 too
    expect(row?.staleSince).not.toBeNull();
    expect(recall.deleteCitingFacts).toHaveBeenCalledWith(G, ["e_1", "e_2"]);
  });

  it("tombstones the source entries: replaying the same session turn submits nothing", async () => {
    const { deps, client, ledger, submit, messages, logger } = await setup();
    submit.mockClear();
    await removeHighlight(G, "hl_sleep", deps);
    const replay = await captureWithReceipts({
      client,
      ledger,
      groupId: G,
      messages,
      inFlight: new Set(),
    });
    expect(submit).not.toHaveBeenCalled();
    expect(replay.tombstoned).toBe(2);
    // ep_old_untracked had no receipt: deleted, not tombstoned, counted.
    expect(String(logger.info.mock.calls.at(-1)?.[0])).toMatch(/untracked_episodes=1/);
  });

  it("not_found (unknown id, another user's id, or already removed) is idempotent SUCCEEDED", async () => {
    const { deps, graph } = await setup();
    expect(await removeHighlight(G, "hl_nope", deps)).toEqual({
      status: "SUCCEEDED",
      retryable: false,
      reasons: ["not_found"],
      removed_facts: 0,
    });
    expect(await removeHighlight("ok_none", "hl_sleep", deps)).toMatchObject({
      reasons: ["not_found"],
    });
    expect(graph.get(G)).toHaveLength(3);
    await removeHighlight(G, "hl_sleep", deps);
    expect(await removeHighlight(G, "hl_sleep", deps)).toMatchObject({
      status: "SUCCEEDED",
      reasons: ["not_found"],
    });
  });

  it("never deletes another group's fact, even if a cached source names one", async () => {
    const { deps, graph, store } = await setup();
    await store.put(G, { state: "ready", payload: [hl("hl_bad", ["b_1"])] }, await store.clock());
    const r = await removeHighlight(G, "hl_bad", deps);
    expect(r).toMatchObject({ status: "SUCCEEDED", removed_facts: 0 });
    expect(graph.get("ok_b")?.map((f) => f.id)).toEqual(["b_1"]);
  });

  it("a tombstone write failure deletes nothing: FAILED retryable store_error", async () => {
    const { deps, graph, ledger, store } = await setup();
    vi.spyOn(ledger, "addTombstones").mockRejectedValueOnce(new Error("db"));
    const r = await removeHighlight(G, "hl_sleep", deps);
    expect(r).toEqual({
      status: "FAILED",
      retryable: true,
      reasons: ["store_error"],
      removed_facts: 0,
    });
    expect(graph.get(G)).toHaveLength(3);
    expect((await store.get(G))?.payload).toHaveLength(3);
  });

  it("a partial delete failure is FAILED retryable; a retry completes (deleted facts count as gone)", async () => {
    const { deps, client, graph, store } = await setup();
    client.forgetFacts.mockRejectedValueOnce(new Error("zep 500"));
    expect(await removeHighlight(G, "hl_sleep", deps)).toMatchObject({
      status: "FAILED",
      retryable: true,
      reasons: ["store_error"],
    });
    expect((await store.get(G))?.payload).toHaveLength(3); // cache untouched until the delete succeeds
    const retry = await removeHighlight(G, "hl_sleep", deps);
    expect(retry.status).toBe("SUCCEEDED");
    expect(graph.get(G)?.map((f) => f.id)).toEqual(["e_3"]);
  });

  it("a recall failure after the delete leaves the highlight cached; the retry finishes everything", async () => {
    const { deps, recall, store } = await setup();
    recall.deleteCitingFacts.mockRejectedValueOnce(new Error("db"));
    expect((await removeHighlight(G, "hl_sleep", deps)).status).toBe("FAILED");
    // The cache drop is the LAST step, so the highlight is still there to retry.
    expect((await store.get(G))?.payload.map((h) => h.id)).toContain("hl_sleep");
    const retry = await removeHighlight(G, "hl_sleep", deps);
    expect(retry).toMatchObject({ status: "SUCCEEDED", reasons: [] });
    expect(recall.deleteCitingFacts).toHaveBeenCalledTimes(2);
    expect((await store.get(G))?.payload.map((h) => h.id)).toEqual(["hl_other"]);
  });

  it("a cache failure is FAILED retryable; the retry finishes", async () => {
    const { deps, store } = await setup();
    vi.spyOn(store, "dropCiting").mockRejectedValueOnce(new Error("db"));
    expect((await removeHighlight(G, "hl_sleep", deps)).status).toBe("FAILED");
    expect((await removeHighlight(G, "hl_sleep", deps)).status).toBe("SUCCEEDED");
    expect((await store.get(G))?.payload.map((h) => h.id)).toEqual(["hl_other"]);
  });

  it("logs counts only: no group, highlight id or fact text", async () => {
    const { deps, logger } = await setup();
    await removeHighlight(G, "hl_sleep", deps);
    const text = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(text).not.toMatch(/ok_a|hl_sleep|fact e_/);
  });
});
