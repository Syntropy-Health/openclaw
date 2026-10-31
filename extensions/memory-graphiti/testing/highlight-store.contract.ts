/**
 * One behavioural contract for every HighlightStore (store.ts): the Postgres store
 * (highlights/store.integration.test.ts) and the in-memory fake the tests above the
 * store use (testing/fake-highlight-store.test.ts). Each store runs the SAME cases, so
 * the fake cannot drift from the real semantics without a failing test.
 *
 * Time is moved by the harness (the Postgres store reads the database clock, the fake
 * an injected one), never by the cases. Every case uses its own groups; the suite removes
 * them at the end. Due-lists are filtered to this run's prefix, so rows other runs left in a
 * shared database cannot crowd this run's rows out of the limit.
 */
import { afterAll, beforeAll, expect, it, type describe } from "vitest";
import type { HighlightStore, HighlightWrite } from "../highlights/store.js";
import type { Highlight } from "../highlights/types.js";

export type HighlightStoreHarness = {
  store: HighlightStore;
  /** Prefix unique to this run, so cases never meet rows from another run. */
  prefix: string;
  /** Set the group's stale mark to `seconds` before now (store clock). */
  staleAgo(groupId: string, seconds: number): Promise<void>;
  /** Move the group's on-demand day back by one (a new UTC day for the cap). */
  previousDay(groupId: string): Promise<void>;
  /** Use up today's on-demand slots: count = `count`, day = today. */
  capToday(groupId: string, count: number): Promise<void>;
  /** End the group's regeneration lease now. */
  expireLease(groupId: string): Promise<void>;
  close?(): Promise<void>;
};

export const contractHighlight = (id: string, factIds: string[]): Highlight => ({
  id,
  category: "sleep",
  title: `title ${id} with "quotes" & ünïcödé`,
  body: "One sentence.",
  first_seen: "2026-10-01",
  last_seen: "2026-10-25",
  occurrences: 2,
  recurring: false,
  score: 0.5,
  sources: factIds.map((f) => ({ fact_id: f, fact: `fact ${f}`, last_seen: "2026-10-25" })),
});
const hl = contractHighlight;

export function describeHighlightStoreContract(
  describeFn: typeof describe | typeof describe.skip,
  name: string,
  setup: () => Promise<HighlightStoreHarness>,
): void {
  describeFn(`HighlightStore contract: ${name}`, () => {
    let h: HighlightStoreHarness;
    const used = new Set<string>();
    /** A fresh group id for one case; removed after the suite. */
    const group = (tag: string) => {
      const g = `${h.prefix}_${tag}`;
      used.add(g);
      return g;
    };
    /** This run's groups in a due-list, in the store's order. */
    const ours = (ids: string[]) => ids.filter((g) => g.startsWith(`${h.prefix}_`));
    const epochOf = async (g: string) => (await h.store.get(g))?.epoch ?? "0";
    /** put as a run that starts now with the row's current epoch would. */
    const putNow = async (g: string, w: HighlightWrite) =>
      h.store.put(g, w, await h.store.clock(), await epochOf(g));
    /** A group with a ready row holding `payload`. */
    const ready = async (g: string, payload: Highlight[]) => {
      await h.store.claimOnDemand(g, 3, { create: true });
      expect(await putNow(g, { state: "ready", payload })).toBe(true);
    };

    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      if (h) {
        try {
          for (const g of used) {
            await h.store.deleteGroup(g);
          }
        } finally {
          await h.close?.();
        }
      }
    });

    it("put on a group with no row writes nothing (a forget that ran first stays total)", async () => {
      const g = group("put_norow");
      expect(await h.store.get(g)).toBeNull();
      expect(await putNow(g, { state: "ready", payload: [hl("hl_x", ["e_x"])] })).toBe(false);
      expect(await h.store.get(g)).toBeNull();
    });

    it("put then get round-trips the payload exactly and clears the stale mark", async () => {
      const g = group("roundtrip");
      const payload = [hl("hl_1", ["e_1", "e_2"]), hl("hl_2", ["e_2", "e_3"])];
      await ready(g, payload);
      const row = await h.store.get(g);
      expect(row).toMatchObject({ state: "ready", payload, staleSince: null });
      expect(row?.sourceFactIds.toSorted()).toEqual(["e_1", "e_2", "e_3"]);
      expect(row?.generatedAt).toBeInstanceOf(Date);
    });

    it("get returns highlights in the contract's key order", async () => {
      const g = group("order");
      await ready(g, [hl("hl_1", ["e_1"])]);
      const row = await h.store.get(g);
      expect(Object.keys(row!.payload[0])).toEqual([
        "id",
        "category",
        "title",
        "body",
        "first_seen",
        "last_seen",
        "occurrences",
        "recurring",
        "score",
        "sources",
      ]);
      expect(Object.keys(row!.payload[0].sources[0])).toEqual(["fact_id", "fact", "last_seen"]);
    });

    it("markStale sets the stale mark on an existing row only", async () => {
      const g = group("mark");
      const none = group("mark_none");
      await ready(g, [hl("hl_1", ["e_1"])]);
      await h.store.markStale(g);
      expect((await h.store.get(g))?.staleSince).toBeInstanceOf(Date);
      await h.store.markStale(none);
      expect(await h.store.get(none)).toBeNull();
    });

    it("put clears the stale mark only when no mark arrived after the generation started", async () => {
      const g = group("stale_order");
      await ready(g, [hl("hl_1", ["e_1"])]);
      const startedBefore = await h.store.clock();
      await h.store.markStale(g);
      // The write lands; only the newer mark survives it.
      expect(
        await h.store.put(
          g,
          { state: "ready", payload: [hl("hl_2", ["e_2"])] },
          startedBefore,
          await epochOf(g),
        ),
      ).toBe(true);
      const kept = await h.store.get(g);
      expect(kept?.payload.map((x) => x.id)).toEqual(["hl_2"]);
      expect(kept?.staleSince).toBeInstanceOf(Date);
      await putNow(g, { state: "ready", payload: [hl("hl_3", ["e_3"])] });
      expect((await h.store.get(g))?.staleSince).toBeNull();
    });

    it("empty state stores an empty payload and no source ids; groups never cross", async () => {
      const a = group("empty_a");
      const b = group("empty_b");
      await ready(a, [hl("hl_1", ["e_1"])]);
      await h.store.claimOnDemand(b, 3, { create: true });
      await putNow(b, { state: "empty", payload: [] });
      expect(await h.store.get(b)).toMatchObject({
        state: "empty",
        payload: [],
        sourceFactIds: [],
      });
      expect((await h.store.get(a))?.state).toBe("ready");
    });

    it("deleteGroup removes the row and reports the count", async () => {
      const g = group("delete");
      await h.store.claimOnDemand(g, 3, { create: true });
      expect(await h.store.deleteGroup(g)).toBe(1);
      expect(await h.store.get(g)).toBeNull();
      expect(await h.store.deleteGroup(g)).toBe(0);
    });

    it("claimOnDemand: a first read inserts an unavailable placeholder that is pending", async () => {
      const g = group("claim_first");
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(true);
      const row = await h.store.get(g);
      expect(row).toMatchObject({ state: "unavailable", payload: [], sourceFactIds: [] });
      expect(row?.staleSince).toBeInstanceOf(Date);
    });

    it("claimOnDemand: at most `cap` per UTC day; a new day resets the count; payload untouched", async () => {
      const g = group("claim_cap");
      await ready(g, [hl("hl_c", ["e_c"])]); // slot 1
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(true);
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(true);
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(false);
      expect((await h.store.get(g))?.state).toBe("ready");
      await h.previousDay(g);
      // A new day: the count restarts at 1, so exactly 3 more claims succeed.
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(true);
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(true);
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(true);
      expect(await h.store.claimOnDemand(g, 3, { create: true })).toBe(false);
    });

    it("claimOnDemand without create never inserts (the worker cannot re-create a forgotten row)", async () => {
      const g = group("claim_nocreate");
      expect(await h.store.claimOnDemand(g, 3)).toBe(false);
      expect(await h.store.get(g)).toBeNull();
    });

    it("staleDue: only groups stale for at least the debounce and still under today's cap", async () => {
      const due = group("due_yes");
      const capped = group("due_capped");
      const fresh = group("due_fresh");
      const clean = group("due_clean");
      for (const g of [due, capped, fresh, clean]) {
        await ready(g, [hl("hl_1", ["e_1"])]);
      }
      await h.store.markStale(due);
      await h.staleAgo(due, 180);
      await h.store.markStale(capped);
      await h.staleAgo(capped, 180);
      await h.capToday(capped, 3);
      await h.store.markStale(fresh);
      await h.staleAgo(fresh, 30);
      const got = ours(await h.store.staleDue({ debounceSec: 120, cap: 3, limit: 100_000 }));
      expect(got).toContain(due);
      expect(got).not.toContain(capped);
      expect(got).not.toContain(fresh);
      expect(got).not.toContain(clean);
    });

    it("nightlyDue: every stale group, whatever its on-demand count", async () => {
      const capped = group("night_capped");
      const clean = group("night_clean");
      await ready(capped, [hl("hl_1", ["e_1"])]);
      await ready(clean, [hl("hl_1", ["e_1"])]);
      await h.store.markStale(capped);
      await h.capToday(capped, 3);
      const got = ours(await h.store.nightlyDue(100_000));
      expect(got).toContain(capped);
      expect(got).not.toContain(clean);
    });

    it("dropCiting: removes every highlight citing a fact, keeps order, recomputes ids, marks stale", async () => {
      const g = group("drop");
      await ready(g, [
        hl("hl_1", ["e_1", "e_2"]),
        hl("hl_2", ["e_3"]),
        hl("hl_3", ["e_2", "e_4"]),
        hl("hl_4", ["e_5"]),
      ]);
      const epochBefore = await epochOf(g);
      expect(await h.store.dropCiting(g, ["e_2"])).toBe(2);
      const row = await h.store.get(g);
      expect(row?.payload.map((x) => x.id)).toEqual(["hl_2", "hl_4"]);
      expect(row?.sourceFactIds.toSorted()).toEqual(["e_3", "e_5"]);
      expect(row?.state).toBe("ready");
      expect(row?.staleSince).toBeInstanceOf(Date);
      expect(row?.epoch).not.toBe(epochBefore);
      // Nothing cites e_9: 0, and the row is untouched (no epoch bump, no new stale mark,
      // so an in-flight put is not refused for nothing).
      const unchanged = await h.store.get(g);
      expect(await h.store.dropCiting(g, ["e_9"])).toBe(0);
      expect(await h.store.get(g)).toEqual(unchanged);
      expect(await h.store.dropCiting(g, [])).toBe(0);
      // Dropping the rest leaves a ready row with no highlights as unavailable.
      expect(await h.store.dropCiting(g, ["e_3", "e_5"])).toBe(2);
      expect(await h.store.get(g)).toMatchObject({
        state: "unavailable",
        payload: [],
        sourceFactIds: [],
      });
      // A group with no row: 0, nothing created.
      const none = group("drop_none");
      expect(await h.store.dropCiting(none, ["e_1"])).toBe(0);
      expect(await h.store.get(none)).toBeNull();
    });

    it("staleDue and nightlyDue list the oldest stale mark first", async () => {
      const old = group("ord_old");
      const mid = group("ord_mid");
      const young = group("ord_young");
      for (const [g, ago] of [
        [young, 150],
        [old, 400],
        [mid, 250],
      ] as const) {
        await ready(g, [hl("hl_1", ["e_1"])]);
        await h.store.markStale(g);
        await h.staleAgo(g, ago);
      }
      const want = [old, mid, young];
      const isOrd = (g: string) => want.includes(g);
      expect(
        ours(await h.store.staleDue({ debounceSec: 120, cap: 3, limit: 100_000 })).filter(isOrd),
      ).toEqual(want);
      expect(ours(await h.store.nightlyDue(100_000)).filter(isOrd)).toEqual(want);
    });

    it("dropCiting touches ONLY the given group's row", async () => {
      const g1 = group("drop_x1");
      const g2 = group("drop_x2");
      await ready(g1, [hl("hl_x1", ["e_shared"]), hl("hl_k", ["e_k"])]);
      await ready(g2, [hl("hl_x2", ["e_shared"]), hl("hl_k", ["e_k"])]);
      const before = await h.store.get(g2);
      expect(await h.store.dropCiting(g1, ["e_shared"])).toBe(1);
      expect(await h.store.get(g2)).toEqual(before);
    });

    it("RACE: a put whose run started before a remove (epoch moved) writes nothing", async () => {
      const g = group("race_remove");
      await ready(g, [hl("hl_1", ["e_1"]), hl("hl_2", ["e_2"])]);
      const atStart = await h.store.get(g);
      const startedAt = await h.store.clock();
      expect(await h.store.dropCiting(g, ["e_1"])).toBe(1);
      expect(
        await h.store.put(
          g,
          { state: "ready", payload: [hl("hl_1", ["e_1"])] },
          startedAt,
          atStart!.epoch,
        ),
      ).toBe(false);
      expect((await h.store.get(g))?.payload.map((x) => x.id)).toEqual(["hl_2"]);
    });

    it("RACE: a put whose run started before a forget-and-recreate (new row) writes nothing", async () => {
      const g = group("race_forget");
      await h.store.claimOnDemand(g, 3, { create: true });
      const atStart = await h.store.get(g);
      const startedAt = await h.store.clock();
      await h.store.deleteGroup(g);
      await h.store.claimOnDemand(g, 3, { create: true });
      expect(
        await h.store.put(
          g,
          { state: "ready", payload: [hl("hl_old", ["e_9"])] },
          startedAt,
          atStart!.epoch,
        ),
      ).toBe(false);
      expect((await h.store.get(g))?.payload).toEqual([]);
    });

    it("lease: one holder at a time; released by put or releaseLease; expires; none without a row", async () => {
      const g = group("lease");
      await h.store.claimOnDemand(g, 3, { create: true });
      expect(await h.store.acquireLease(g, 120)).toBe(true);
      expect(await h.store.acquireLease(g, 120)).toBe(false);
      await putNow(g, { state: "empty", payload: [] });
      expect(await h.store.acquireLease(g, 120)).toBe(true);
      await h.store.releaseLease(g);
      expect(await h.store.acquireLease(g, 120)).toBe(true);
      await h.expireLease(g);
      expect(await h.store.acquireLease(g, 120)).toBe(true);
      expect(await h.store.acquireLease(group("lease_none"), 120)).toBe(false);
    });
  });
}
