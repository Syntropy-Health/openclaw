import { createHash } from "node:crypto";
import type { MemoryFact } from "../client.js";
import { minimiseForMemory } from "../minimise.js";
import { checkNarration } from "./narration-guard.js";
import {
  DEFAULT_RANK_CONFIG,
  MAX_HIGHLIGHTS,
  type RankConfig,
  type RankInput,
  rankHighlights,
} from "./rank.js";
import {
  HIGHLIGHT_CATEGORIES,
  isHighlightCategory,
  type Highlight,
  type HighlightSource,
} from "./types.js";

/** Most facts given to the model (newest first): a token budget. */
export const INPUT_FACTS_MAX = 300;
/** Each fact's text is cut to this many characters before the model sees it. */
export const FACT_TEXT_MAX = 300;
/** Most raw facts in the unavailable fallback (PVR F3). */
export const FALLBACK_FACTS_MAX = 20;
export const TITLE_MAX = 80;
/** One sentence: the served body is bounded and plain text. */
export const BODY_MAX = 240;
/** Markup never reaches the served payload, whatever the consumer does with it. */
const MARKUP = /[<>]|\]\(/;
export const SUMMARISER_TIMEOUT_MS = 30_000;
/** D2: the summariser is pinned to this provider. */
export const SUMMARISER_PROVIDER = "anthropic";

export type RunnerRequest = {
  provider: typeof SUMMARISER_PROVIDER;
  prompt: string;
  timeoutMs: number;
};

/** Runs one model turn with tools disabled and returns its text reply. */
export type HighlightRunner = (req: RunnerRequest) => Promise<string>;

export type GenerateOptions = {
  groupId: string;
  now: Date;
  run: HighlightRunner;
  logger: { info: (m: string) => void; warn: (m: string) => void };
  /** Must be "anthropic" (D2); anything else is refused before any model call. */
  provider?: string;
  rank?: Readonly<RankConfig>;
};

export type DropCounts = {
  schema: number;
  category: number;
  shape: number;
  ref: number;
  guard: number;
};

/**
 * PVR F3: a user's raw recent facts, newest first, valid only, at most
 * FALLBACK_FACTS_MAX. Served when highlights are unavailable.
 */
export function recentFacts(facts: readonly MemoryFact[]): HighlightSource[] {
  return facts
    .filter((f) => !f.invalidAt && !f.expiredAt)
    .toSorted(
      (a, b) =>
        Date.parse(b.validAt ?? b.createdAt) - Date.parse(a.validAt ?? a.createdAt) ||
        (a.id < b.id ? -1 : 1),
    )
    .slice(0, FALLBACK_FACTS_MAX)
    .map((f) => ({
      fact_id: f.id,
      fact: f.fact,
      last_seen: new Date(f.validAt ?? f.createdAt).toISOString().slice(0, 10),
    }));
}

export type GenerateResult =
  | { state: "empty"; highlights: []; dropped: DropCounts }
  | { state: "ready"; highlights: Highlight[]; dropped: DropCounts }
  | {
      state: "unavailable";
      reason: "summariser_error";
      fallback_facts: HighlightSource[];
      dropped: DropCounts;
    };

/** hl_ + sha256(group ‖ sorted source fact ids)[:24]: stable while the sources are. */
export function highlightId(groupId: string, factIds: readonly string[]): string {
  const sorted = [...new Set(factIds)].toSorted();
  const digest = createHash("sha256")
    .update(groupId)
    .update("\u0000")
    .update(sorted.join("\u0000"))
    .digest("hex");
  return `hl_${digest.slice(0, 24)}`;
}

const isValid = (f: MemoryFact) => !f.invalidAt && !f.expiredAt;
const seenAt = (f: MemoryFact) => f.validAt ?? f.createdAt;
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

const toSource = (f: MemoryFact): HighlightSource => ({
  fact_id: f.id,
  fact: f.fact,
  last_seen: day(seenAt(f)),
});

const PROMPT_HEAD = `You summarise what a person has told a health-journal assistant into short highlights for them to review.
Reply with JSON only, no prose, in exactly this shape:
{"highlights": [{"category": one of ${HIGHLIGHT_CATEGORIES.map((c) => `"${c}"`).join(", ")}, "title": "at most ${TITLE_MAX} characters", "body": "exactly one sentence", "refs": ["f1"], "salience": "high" or "normal", "goal_linked": true or false, "goal_ref": "fN" only when goal_linked}]}
Rules:
- At most ${MAX_HIGHLIGHTS} highlights. Each cites the facts it is based on in refs, using only the ref values given below.
- goal_linked is true only when a cited fact states the person's own goal; goal_ref names that fact.
- Describe what the person said, in their terms. Never give advice, recommendations, diagnoses, dosing or treatment claims.
FACTS:
`;

type Parsed = {
  category: string;
  title: string;
  body: string;
  refs: string[];
  salience: "high" | "normal";
  goal_linked: boolean;
  goal_ref?: string;
};

function parseEntry(v: unknown): Parsed | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return null;
  }
  const e = v as Record<string, unknown>;
  const refs = e.refs;
  if (
    typeof e.category !== "string" ||
    typeof e.title !== "string" ||
    typeof e.body !== "string" ||
    !Array.isArray(refs) ||
    refs.length === 0 ||
    !refs.every((r) => typeof r === "string") ||
    (e.salience !== "high" && e.salience !== "normal") ||
    typeof e.goal_linked !== "boolean" ||
    (e.goal_ref !== undefined && typeof e.goal_ref !== "string")
  ) {
    return null;
  }
  return {
    category: e.category,
    title: e.title.trim(),
    body: e.body.trim(),
    refs: [...new Set(refs as string[])],
    salience: e.salience,
    goal_linked: e.goal_linked,
    goal_ref: e.goal_ref as string | undefined,
  };
}

/** One sentence: non-empty, and no sentence end followed by more text. */
const isOneSentence = (s: string) => s.length > 0 && !/[.!?]\s+\S/.test(s);

function readReply(text: string): unknown[] | null {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(raw) as { highlights?: unknown };
    return Array.isArray(parsed?.highlights) ? parsed.highlights : null;
  } catch {
    return null;
  }
}

/**
 * Generate a user's highlights from their facts (A&D §4.2). Pure apart from the
 * injected runner: no store access. Logs counts only.
 */
export async function generateHighlights(
  facts: readonly MemoryFact[],
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const dropped: DropCounts = { schema: 0, category: 0, shape: 0, ref: 0, guard: 0 };
  const valid = facts
    .filter(isValid)
    .toSorted((a, b) => Date.parse(seenAt(b)) - Date.parse(seenAt(a)) || (a.id < b.id ? -1 : 1));
  if (valid.length === 0) {
    return { state: "empty", highlights: [], dropped };
  }
  const unavailable = (why: string): GenerateResult => {
    opts.logger.warn(`memory-highlights: generation unavailable (${why})`);
    return {
      state: "unavailable",
      reason: "summariser_error",
      fallback_facts: recentFacts(valid),
      dropped,
    };
  };

  const provider = opts.provider ?? SUMMARISER_PROVIDER;
  if (provider !== SUMMARISER_PROVIDER) {
    return unavailable("provider not allowed");
  }

  // Local refs (f1, f2, ...) so fact ids are neither visible to nor forgeable by the model.
  const byRef = new Map<string, MemoryFact>();
  const input: Array<{ ref: string; text: string; last_seen: string; episodes: number }> = [];
  for (const f of valid) {
    if (input.length >= INPUT_FACTS_MAX) {
      break;
    }
    const text = minimiseForMemory(f.fact);
    if (!text) {
      continue;
    }
    const ref = `f${input.length + 1}`;
    byRef.set(ref, f);
    input.push({
      ref,
      text: text.slice(0, FACT_TEXT_MAX),
      last_seen: day(seenAt(f)),
      episodes: Math.max(1, new Set(f.episodeIds).size),
    });
  }
  if (input.length === 0) {
    return unavailable("no fact survived minimisation");
  }

  let reply: string;
  try {
    reply = await opts.run({
      provider: SUMMARISER_PROVIDER,
      prompt: PROMPT_HEAD + JSON.stringify(input),
      timeoutMs: SUMMARISER_TIMEOUT_MS,
    });
  } catch {
    return unavailable("runner failed");
  }
  const entries = readReply(reply);
  if (!entries) {
    return unavailable("reply was not the expected JSON");
  }

  const kept: Array<RankInput & { title: string; body: string }> = [];
  for (const raw of entries) {
    const e = parseEntry(raw);
    if (!e) {
      dropped.schema++;
      continue;
    }
    const category = e.category;
    if (!isHighlightCategory(category)) {
      dropped.category++;
      continue;
    }
    if (
      !e.refs.every((r) => byRef.has(r)) ||
      (e.goal_ref !== undefined && !byRef.has(e.goal_ref))
    ) {
      dropped.ref++;
      continue;
    }
    if (
      e.title.length === 0 ||
      e.title.length > TITLE_MAX ||
      !isOneSentence(e.body) ||
      e.body.length > BODY_MAX ||
      MARKUP.test(e.title) ||
      MARKUP.test(e.body) ||
      (e.goal_linked && e.goal_ref === undefined)
    ) {
      dropped.shape++;
      continue;
    }
    if (!checkNarration(e.title).ok || !checkNarration(e.body).ok) {
      dropped.guard++;
      continue;
    }
    const sources = e.refs.map((r) => byRef.get(r)!);
    kept.push({
      id: highlightId(
        opts.groupId,
        sources.map((s) => s.id),
      ),
      category,
      salience: e.salience,
      goal_linked: e.goal_linked,
      title: e.title,
      body: e.body,
      sources,
    });
  }

  // Rank all kept entries, then keep the first (best) entry per id: two entries
  // citing the same source set are the same highlight.
  const ranked = rankHighlights(kept, opts.now, opts.rank ?? DEFAULT_RANK_CONFIG, {
    limit: Number.POSITIVE_INFINITY,
  });
  const seen = new Set<string>();
  const highlights: Highlight[] = [];
  for (const r of ranked) {
    if (seen.has(r.id) || highlights.length >= MAX_HIGHLIGHTS) {
      continue;
    }
    seen.add(r.id);
    highlights.push({
      id: r.id,
      category: r.category,
      title: r.title,
      body: r.body,
      first_seen: day(r.first_seen),
      last_seen: day(r.last_seen),
      occurrences: r.occurrences,
      recurring: r.recurring,
      score: r.score,
      sources: r.sources.map(toSource),
    });
  }

  opts.logger.info(
    `memory-highlights: generated kept=${highlights.length} input=${input.length} dropped ` +
      `schema=${dropped.schema} category=${dropped.category} shape=${dropped.shape} ` +
      `ref=${dropped.ref} guard=${dropped.guard}`,
  );
  if (highlights.length === 0) {
    return unavailable("no entry survived validation");
  }
  return { state: "ready", highlights, dropped };
}
