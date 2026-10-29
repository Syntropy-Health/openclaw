import type { MemoryFact } from "../client.js";

/** Highlight categories (A&D §1a). */
export type HighlightCategory =
  | "sleep"
  | "nutrition"
  | "symptoms"
  | "activity"
  | "mood"
  | "supplements"
  | "other";

/** Ranking constants (plugin config `highlights.rank`; PVR R3 values by default). */
export type RankConfig = {
  halfLifeDays: number;
  wOcc: number;
  wLink: number;
  wSal: number;
};

export const DEFAULT_RANK_CONFIG: Readonly<RankConfig> = Object.freeze({
  halfLifeDays: 14,
  wOcc: 0.5,
  wLink: 0.5,
  wSal: 0.25,
});

/** Most highlights a user is shown. */
export const MAX_HIGHLIGHTS = 7;

/** Episodes at which a highlight is marked recurring. */
export const RECURRING_MIN_OCCURRENCES = 3;

/** What ranking needs from a validated highlight entry. */
export type RankInput = {
  id: string;
  category: HighlightCategory;
  salience: "high" | "normal";
  goal_linked: boolean;
  sources: readonly MemoryFact[];
};

export type HighlightSignals = {
  /** ISO time: earliest `validAt ?? createdAt` over the sources. */
  first_seen: string;
  /** ISO time: latest `validAt ?? createdAt` over the sources. */
  last_seen: string;
  /** Distinct source episodes, at least 1. */
  occurrences: number;
  recurring: boolean;
};

export type RankedHighlight<T extends RankInput = RankInput> = T &
  HighlightSignals & {
    score: number;
  };

const DAY_MS = 86_400_000;

const seenAt = (f: MemoryFact): string => f.validAt ?? f.createdAt;

/**
 * Signals derived from an entry's own sources (A&D §4.3). Occurrences count
 * episodes, not facts, so one message that yielded three facts counts once.
 */
export function deriveSignals(sources: readonly MemoryFact[]): HighlightSignals {
  if (sources.length === 0) {
    throw new Error("a highlight needs at least one source");
  }
  let first = seenAt(sources[0]);
  let last = first;
  const episodes = new Set<string>();
  for (const f of sources) {
    const at = seenAt(f);
    if (Date.parse(at) < Date.parse(first)) {
      first = at;
    }
    if (Date.parse(at) > Date.parse(last)) {
      last = at;
    }
    for (const e of f.episodeIds) {
      episodes.add(e);
    }
  }
  const occurrences = Math.max(1, episodes.size);
  return {
    first_seen: first,
    last_seen: last,
    occurrences,
    recurring: occurrences >= RECURRING_MIN_OCCURRENCES,
  };
}

function score(
  entry: RankInput,
  signals: HighlightSignals,
  now: Date,
  cfg: Readonly<RankConfig>,
): number {
  // A future last_seen (clock skew) counts as now: recency never exceeds 1.
  const ageDays = Math.max(0, (now.getTime() - Date.parse(signals.last_seen)) / DAY_MS);
  const recency = 0.5 ** (ageDays / cfg.halfLifeDays);
  const linked = entry.goal_linked || entry.category === "symptoms" ? 1 : 0;
  const high = entry.salience === "high" ? 1 : 0;
  const importance =
    1 + cfg.wOcc * Math.log2(signals.occurrences) + cfg.wLink * linked + cfg.wSal * high;
  return importance * recency;
}

/** R3 score: importance x recency (A&D §4.3). */
export function scoreHighlight(
  entry: RankInput,
  now: Date,
  cfg: Readonly<RankConfig> = DEFAULT_RANK_CONFIG,
): number {
  return score(entry, deriveSignals(entry.sources), now, cfg);
}

/**
 * Rank entries best first: score descending, then last_seen descending, then id.
 * Returns at most MAX_HIGHLIGHTS, each with its derived signals and score. Pure:
 * the input is not modified.
 */
export function rankHighlights<T extends RankInput>(
  entries: readonly T[],
  now: Date,
  cfg: Readonly<RankConfig> = DEFAULT_RANK_CONFIG,
): RankedHighlight<T>[] {
  const scored = entries.map((e) => {
    const signals = deriveSignals(e.sources);
    return { ...e, ...signals, score: score(e, signals, now, cfg) };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.last_seen) - Date.parse(a.last_seen) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return scored.slice(0, MAX_HIGHLIGHTS);
}
