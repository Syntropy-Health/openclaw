/** canonicalHighlights: the read rule both stores share (no database). */
import { describe, expect, it, vi } from "vitest";
import { canonicalHighlights } from "./store.js";

const ok = {
  id: "hl_1",
  category: "sleep",
  title: "t",
  body: "b.",
  first_seen: "2026-10-01",
  last_seen: "2026-10-02",
  occurrences: 1,
  recurring: false,
  score: 1,
  sources: [{ fact_id: "e_1", fact: "f", last_seen: "2026-10-02" }],
};

describe("canonicalHighlights", () => {
  it("malformed entries are left out and counted, never thrown on", () => {
    const counted = vi.fn();
    const out = canonicalHighlights([null, 5, "x", {}, { category: 7 }, ok], counted);
    expect(out.map((h) => h.id)).toEqual(["hl_1"]);
    expect(counted).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("a clean payload reports nothing; a non-array payload is empty", () => {
    const counted = vi.fn();
    expect(canonicalHighlights([ok], counted)).toHaveLength(1);
    expect(canonicalHighlights({ not: "an array" }, counted)).toEqual([]);
    expect(counted).not.toHaveBeenCalled();
  });
});
