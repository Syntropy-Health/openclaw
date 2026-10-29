/** The fake's group scoping matches the Postgres store's (store.integration.test.ts). */
import { describe, expect, it } from "vitest";
import { highlightIdByFact } from "../highlights/store.js";
import type { Highlight } from "../highlights/types.js";
import { FakeHighlightStore } from "./fake-highlight-store.js";

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
