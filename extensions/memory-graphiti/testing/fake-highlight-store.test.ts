/** The fake's group scoping matches the Postgres store's (store.integration.test.ts). */
import { describe, expect, it } from "vitest";
import { highlightIdByFact } from "../highlights/store.js";
import type { Highlight } from "../highlights/types.js";
import { FakeHighlightStore } from "./fake-highlight-store.js";
import { describeHighlightStoreContract } from "./highlight-store.contract.js";

/**
 * The fake runs the same contract as the Postgres store. Its clock ticks 1 ms per
 * read, so "after the generation started" is strict, as the database clock is.
 */
describeHighlightStoreContract(describe, "in-memory fake", async () => {
  let t = Date.parse("2026-10-30T12:00:00Z");
  const now = () => new Date(++t);
  const store = new FakeHighlightStore(now);
  const row = (g: string) => {
    const r = store.rows.get(g);
    if (!r) {
      throw new Error(`no row for ${g}`);
    }
    return r;
  };
  return {
    store,
    prefix: "fake",
    staleAgo: async (g, seconds) => {
      row(g).staleSince = new Date(t - seconds * 1000);
    },
    previousDay: async (g) => {
      const r = row(g);
      const d = new Date(`${r.ondemandDay}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      r.ondemandDay = d.toISOString().slice(0, 10);
    },
    capToday: async (g, count) => {
      const r = row(g);
      r.ondemandDay = new Date(t).toISOString().slice(0, 10);
      r.ondemandCount = count;
    },
    expireLease: async (g) => {
      row(g).leaseUntil = t - 1000;
    },
  };
});

const hl = (id: string, f: string): Highlight => ({
  id,
  category: "sleep",
  title: "t",
  body: "b.",
  first_seen: "2026-10-20",
  last_seen: "2026-10-20",
  occurrences: 1,
  recurring: false,
  score: 1,
  sources: [{ fact_id: f, fact: "x", last_seen: "2026-10-20" }],
});

describe("FakeHighlightStore", () => {
  it("dropCiting touches only the given group", async () => {
    const s = new FakeHighlightStore();
    for (const g of ["g1", "g2"]) {
      await s.claimOnDemand(g, 3, { create: true });
      await s.put(
        g,
        { state: "ready", payload: [hl("a", "e_shared")] },
        await s.clock(),
        (await s.get(g))!.epoch,
      );
    }
    const before = await s.get("g2");
    expect(await s.dropCiting("g1", ["e_shared"])).toBe(1);
    expect(await s.get("g2")).toEqual(before);
  });

  it("highlightIdByFact: the first highlight citing each fact, in served order", () => {
    const m = highlightIdByFact([hl("h1", "e1"), hl("h2", "e1"), hl("h3", "e2")]);
    expect([...m.entries()]).toEqual([
      ["e1", "h1"],
      ["e2", "h3"],
    ]);
  });
});
