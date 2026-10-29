/**
 * R3 ranking (A&D §4.3): a pure function of the entry's own sources, the clock
 * and the configured constants.
 */
import { describe, expect, it } from "vitest";
import type { MemoryFact } from "../client.js";
import {
  DEFAULT_RANK_CONFIG,
  MAX_HIGHLIGHTS,
  type RankInput,
  deriveSignals,
  rankHighlights,
  scoreHighlight,
} from "./rank.js";

const NOW = new Date("2026-10-29T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let n = 0;
const src = (ageDays: number, episodes: string[], extra: Partial<MemoryFact> = {}): MemoryFact => ({
  id: `e_${++n}`,
  fact: "f",
  name: "RELATES_TO",
  validAt: null,
  invalidAt: null,
  createdAt: daysAgo(ageDays),
  expiredAt: null,
  episodeIds: episodes,
  ...extra,
});

const entry = (
  id: string,
  sources: MemoryFact[],
  extra: Partial<Omit<RankInput, "id" | "sources">> = {},
): RankInput => ({
  id,
  category: "sleep",
  salience: "normal",
  goal_linked: false,
  sources,
  ...extra,
});

describe("deriveSignals", () => {
  it("last/first seen use validAt over createdAt; occurrences count distinct episodes", () => {
    const s = deriveSignals([
      src(10, ["ep1", "ep2"]),
      src(30, ["ep2"], { validAt: daysAgo(2) }), // validAt wins: seen 2 days ago
      src(20, ["ep3"]),
    ]);
    expect(s.last_seen).toBe(daysAgo(2));
    expect(s.first_seen).toBe(daysAgo(20));
    expect(s.occurrences).toBe(3);
    expect(s.recurring).toBe(true);
  });

  it("one message that yields several facts counts once; no episodes counts as 1", () => {
    expect(deriveSignals([src(1, ["ep1"]), src(1, ["ep1"]), src(1, ["ep1"])]).occurrences).toBe(1);
    const none = deriveSignals([src(1, [])]);
    expect(none.occurrences).toBe(1);
    expect(none.recurring).toBe(false);
  });

  it("an entry with no sources is rejected", () => {
    expect(() => deriveSignals([])).toThrow(/at least one source/);
  });
});

describe("scoreHighlight", () => {
  it("matches the formula: importance x 0.5^(age/halfLife)", () => {
    // 4 episodes, symptoms (link bonus), high salience, last seen 14 days ago.
    const e = entry("x", [src(14, ["a", "b", "c", "d"])], {
      category: "symptoms",
      salience: "high",
    });
    const importance = 1 + 0.5 * Math.log2(4) + 0.5 + 0.25;
    expect(scoreHighlight(e, NOW)).toBeCloseTo(importance * 0.5, 12);
  });

  it("goal_linked earns the same link bonus as symptoms, and they do not stack", () => {
    const base = scoreHighlight(entry("a", [src(0, ["e"])]), NOW);
    const goal = scoreHighlight(entry("b", [src(0, ["e"])], { goal_linked: true }), NOW);
    const both = scoreHighlight(
      entry("c", [src(0, ["e"])], { goal_linked: true, category: "symptoms" }),
      NOW,
    );
    expect(goal - base).toBeCloseTo(0.5, 12);
    expect(both).toBeCloseTo(goal, 12);
  });

  it("a last_seen in the future (clock skew) is treated as now, never above full recency", () => {
    const e = entry("f", [src(-3, ["e"])]);
    expect(scoreHighlight(e, NOW)).toBeCloseTo(1, 12);
  });

  it("property: score never rises with age", () => {
    for (let age = 0; age < 200; age += 3) {
      const younger = scoreHighlight(entry("y", [src(age, ["a", "b"])]), NOW);
      const older = scoreHighlight(entry("o", [src(age + 1, ["a", "b"])]), NOW);
      expect(older).toBeLessThanOrEqual(younger);
    }
  });

  it("property: score never falls with occurrences", () => {
    for (let k = 1; k < 40; k++) {
      const eps = (m: number) => Array.from({ length: m }, (_, i) => `ep${i}`);
      const fewer = scoreHighlight(entry("a", [src(5, eps(k))]), NOW);
      const more = scoreHighlight(entry("b", [src(5, eps(k + 1))]), NOW);
      expect(more).toBeGreaterThanOrEqual(fewer);
    }
  });
});

describe("rankHighlights (G3 ordering fixture)", () => {
  // Each case is chosen so one signal decides it; the expected order is the
  // formula's, written out by hand.
  const fixture = (): RankInput[] => [
    entry("hl_stale_frequent", [src(42, ["a", "b", "c", "d", "e", "f", "g", "h"])]), // (1+1.5)*0.125 = 0.3125
    entry("hl_fresh_once", [src(0, ["a"])]), // 1*1 = 1
    entry("hl_symptom_week", [src(7, ["a", "b"])], { category: "symptoms" }), // 2*0.7071 = 1.414
    entry("hl_goal_month", [src(28, ["a", "b"])], { goal_linked: true }), // 2*0.25 = 0.5
    entry("hl_high_fortnight", [src(14, ["a", "b", "c", "d"])], { salience: "high" }), // 2.25*0.5 = 1.125
  ];

  it("orders by score, best first", () => {
    expect(rankHighlights(fixture(), NOW).map((r) => r.id)).toEqual([
      "hl_symptom_week",
      "hl_high_fortnight",
      "hl_fresh_once",
      "hl_goal_month",
      "hl_stale_frequent",
    ]);
  });

  it("the constants come from config: a long half-life lets frequency beat freshness", () => {
    const order = rankHighlights(fixture(), NOW, { ...DEFAULT_RANK_CONFIG, halfLifeDays: 365 }).map(
      (r) => r.id,
    );
    expect(order[0]).toBe("hl_stale_frequent");
    expect(order).not.toEqual(rankHighlights(fixture(), NOW).map((r) => r.id));
  });

  it("ties break on last_seen (newest first), then id", () => {
    const same = [src(3, ["a"])];
    const ranked = rankHighlights([entry("hl_b", same), entry("hl_a", same)], NOW);
    expect(ranked.map((r) => r.id)).toEqual(["hl_a", "hl_b"]);

    const zeroDecay = { ...DEFAULT_RANK_CONFIG, halfLifeDays: Number.POSITIVE_INFINITY };
    const byDate = rankHighlights(
      // The id order (a before z) is the opposite of the date order, so only the
      // last_seen tie-break can produce this result.
      [entry("hl_a_old", [src(9, ["a"])]), entry("hl_z_new", [src(1, ["a"])])],
      NOW,
      zeroDecay,
    );
    expect(byDate.map((r) => r.id)).toEqual(["hl_z_new", "hl_a_old"]);
  });

  it(`keeps at most ${MAX_HIGHLIGHTS}, and returns the derived signals with each`, () => {
    const many = Array.from({ length: 12 }, (_, i) => entry(`hl_${i}`, [src(i, ["a"])]));
    const ranked = rankHighlights(many, NOW);
    expect(ranked).toHaveLength(MAX_HIGHLIGHTS);
    expect(ranked[0]).toMatchObject({ id: "hl_0", occurrences: 1, recurring: false });
    expect(ranked[0].score).toBeCloseTo(1, 12);
  });

  it("does not mutate its input", () => {
    const input = fixture();
    const snapshot = structuredClone(input);
    rankHighlights(input, NOW);
    expect(input).toEqual(snapshot);
  });
});
