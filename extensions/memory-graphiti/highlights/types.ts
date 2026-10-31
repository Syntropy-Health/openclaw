/**
 * Highlight categories (A&D §1a): the one list. The type, the summariser prompt and
 * the output check all derive from it, so adding a category is one edit.
 */
export const HIGHLIGHT_CATEGORIES = Object.freeze([
  "sleep",
  "nutrition",
  "symptoms",
  "activity",
  "mood",
  "supplements",
  "other",
] as const);
export type HighlightCategory = (typeof HIGHLIGHT_CATEGORIES)[number];

/** Whether a value is one of the categories (narrows untrusted model output). */
export function isHighlightCategory(v: unknown): v is HighlightCategory {
  return typeof v === "string" && (HIGHLIGHT_CATEGORIES as readonly string[]).includes(v);
}

/** One source fact of a highlight, as served (A&D §1a). */
export type HighlightSource = {
  fact_id: string;
  fact: string;
  /** Date only (UTC), YYYY-MM-DD. */
  last_seen: string;
};

/** One highlight, exactly as served by GET /gateway/memory/highlights (A&D §1a). */
export type Highlight = {
  /** hl_ + sha256(group ‖ sorted source fact ids)[:24]. */
  id: string;
  category: HighlightCategory;
  title: string;
  body: string;
  /** Date only (UTC). */
  first_seen: string;
  /** Date only (UTC). */
  last_seen: string;
  occurrences: number;
  recurring: boolean;
  score: number;
  sources: HighlightSource[];
};

/** Cache states (the route adds not_enabled, which is never stored). */
export type HighlightCacheState = "ready" | "empty" | "unavailable";
