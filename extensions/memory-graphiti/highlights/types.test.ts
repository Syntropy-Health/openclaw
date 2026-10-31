/** The one category list (A&D §1a) and its guard. */
import { describe, expect, it } from "vitest";
import { HIGHLIGHT_CATEGORIES, isHighlightCategory } from "./types.js";

describe("highlight categories", () => {
  it("is exactly the A&D §1a list, in order, and frozen", () => {
    expect([...HIGHLIGHT_CATEGORIES]).toEqual([
      "sleep",
      "nutrition",
      "symptoms",
      "activity",
      "mood",
      "supplements",
      "other",
    ]);
    expect(Object.isFrozen(HIGHLIGHT_CATEGORIES)).toBe(true);
  });

  it("isHighlightCategory accepts every category and nothing else", () => {
    for (const c of HIGHLIGHT_CATEGORIES) {
      expect(isHighlightCategory(c)).toBe(true);
    }
    for (const v of ["", "Sleep", "sleep ", "diet", 1, null, undefined, {}, ["sleep"]]) {
      expect(isHighlightCategory(v)).toBe(false);
    }
  });
});
