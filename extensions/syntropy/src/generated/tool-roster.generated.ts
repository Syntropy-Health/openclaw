// AUTO-GENERATED from apps/Syntropy-Journals/schemas/manifest/*.manifest.yaml — DO NOT EDIT.
// Regenerate with `npm run codegen:openclaw-tool-roster` in shared/schemas/.
//
// Issue #200. This roster owns tool MEMBERSHIP. tools.ts supplies the TypeBox
// `parameters` and the UI `label` locally (neither exists upstream yet) and is
// wired so that a disagreement between this roster and that local map is a
// COMPILE ERROR, not a review miss.
//
// Architecture of record: F.1 = (c) Layered
// (docs/superpowers/plans/2026-05-11-sj-mcp-center-layered.md) — one source of
// truth, every surface regenerated from it. (b) Hybrid was rejected precisely
// because 'typed REST and MCP drift by hand'.

/** A tool the SJ MCP surface exposes, as declared by its manifest. */
export interface RosterEntry {
  /** Canonical agent-facing tool name (manifest `name`). */
  readonly name: string;
  /** SJ-side MCP tool name to call over HTTP (manifest `function`). */
  readonly mcpToolName: string;
  /** Manifest `description`, verbatim. */
  readonly description: string;
  /** Manifest `scope` — "consumer" | "both" | … */
  readonly scope: string;
}

export const TOOL_ROSTER = [
  {
    name: "syntropy_analyze_food",
    mcpToolName: "analyze_food",
    description:
      'Parse natural-language food descriptions (e.g. "2 eggs and toast with avocado") into structured entries with macro totals and scoring. Does NOT persist — separate ``syntropy_log_food`` call required to commit.',
    scope: "consumer",
  },
  {
    name: "syntropy_diet_gap",
    mcpToolName: "get_diet_gap",
    description:
      'Compare the user\'s actual macro intake vs ideal targets. Shows which macros (protein, carbs, fat, calories) are over or under their daily targets. Useful for "what should I eat next" recommendations.',
    scope: "consumer",
  },
  {
    name: "syntropy_diet_score",
    mcpToolName: "get_diet_score",
    description:
      "Get the user's diet fulfillment score over the last N days. Returns overall score (0-100), macro score, consistency score, and detailed breakdown. Aggregated from check-in + food-log history.",
    scope: "consumer",
  },
  {
    name: "syntropy_health_profile",
    mcpToolName: "get_health_profile",
    description:
      "Get the user's health profile — dietary preferences, goals, conditions, allergies, and supplement stack. Static-ish context; cache aggressively on the agent side.",
    scope: "consumer",
  },
  {
    name: "syntropy_health_snapshot",
    mcpToolName: "get_health_snapshot",
    description:
      "Get an aggregated health snapshot — food logs, symptoms, medications, and macro totals over the last N days. Single call that returns the multi-axis view; cheaper than calling diet_score + diet_gap + my_checkins separately.",
    scope: "consumer",
  },
  {
    name: "syntropy_log_checkin",
    mcpToolName: "log_checkin",
    description:
      'Record a daily health check-in from free-text content. The system extracts health events (symptoms, medications, mood, energy, sleep) automatically. Use for any wellness signal the user shares, even if not framed as a "check-in".',
    scope: "consumer",
  },
  {
    name: "syntropy_log_food",
    mcpToolName: "log_food",
    description:
      "Log a food entry to your health journal. Captures the food name plus optional meal_type and macros (calories, protein, carbs, fat) into the user's check-in stream.",
    scope: "consumer",
  },
  {
    name: "syntropy_my_checkins",
    mcpToolName: "get_my_checkins",
    description:
      "Get the user's recent health check-ins (default 10, max 50). Returns the raw entries — agent must summarise.",
    scope: "consumer",
  },
  {
    name: "syntropy_my_protocols",
    mcpToolName: "get_my_protocols",
    description:
      "Get the wellness protocols the user is subscribed to. Returns active protocol subscriptions with adherence data.",
    scope: "consumer",
  },
  {
    name: "syntropy_peptide_intake_set_fields",
    mcpToolName: "peptide_intake_set_fields",
    description:
      "Save fields of the user's clinician-gated PEPTIDE / GLP-1 Rx intake incrementally as they come up — partial-MERGE into the ``peptide`` JSONB blob (draft-only; never submits, checks out, or touches the lockout). Only known peptide-intake fields are accepted; unknown keys are reported back in ``rejected`` (never written). Structure/function-safe — collects intake facts + eligibility/consent acknowledgements only.",
    scope: "both",
  },
] as const satisfies readonly RosterEntry[];

/** Canonical tool names, as a union — the membership contract tools.ts is pinned to. */
export type RosterToolName = (typeof TOOL_ROSTER)[number]["name"];

/** Every rostered name, for runtime membership checks. */
export const ROSTER_TOOL_NAMES: readonly RosterToolName[] = TOOL_ROSTER.map((t) => t.name);
