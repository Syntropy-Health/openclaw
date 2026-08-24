// AUTO-GENERATED from apps/Syntropy-Journals/schemas/manifest/*.manifest.yaml — DO NOT EDIT.
// Provenance: SJ manifest-tree sha256 14af926b90103bfbaffab5362fdffbcf6b5d2018b53c60cac64461e302f5827b (11 manifest-tree files hashed; 9 live tools emitted)
// Integrity: self sha256 fbcb00a046aec1ee84d7de81a80fff73bc46c1755edd9f9719ed48a22d4c29e4
// Regenerate in the SyntropyHealth-Applications monorepo (the parent repo that
// pins this one as apps/openclaw): `npm run codegen:openclaw-tool-roster` in its
// shared/schemas/ directory. The generator does not exist in this repository.
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
  /** Manifest `description`, whitespace-normalized to a single line. */
  readonly description: string;
  /** Manifest `scope`, registry-agreement-checked at generation (#214). */
  readonly scope: "consumer" | "both";
  /** Manifest `prompt_hints.when_to_call`, normalized — POSITIVE routing guidance. */
  readonly whenToCall: string;
  /** Manifest `prompt_hints.do_not_call`, normalized — NEGATIVE routing guidance. */
  readonly doNotCall: string;
  /**
   * Manifest `available_channels`, VERBATIM — SJ's reachability declaration.
   * Decision (a) on the pairable-but-unadvertised asymmetry (#214): carrying
   * this verbatim is LEGAL-AND-REPRESENTED — pairability lives in SJ's
   * A7_CHANNELS, reachability lives here, and a channel pairable-but-listed-
   * nowhere is a valid state, not drift. Consumers must not infer pairing
   * from this field.
   */
  readonly availableChannels: readonly string[];
}

export const TOOL_ROSTER = [
  {
    name: "syntropy_analyze_food",
    mcpToolName: "analyze_food",
    description:
      'Parse natural-language food descriptions (e.g. "2 eggs and toast with avocado") into structured entries with macro totals and scoring. Does NOT persist — separate ``syntropy_log_food`` call required to commit.',
    scope: "consumer",
    whenToCall:
      "User describes a meal in natural language and you need structured macros before deciding whether / how to log it.",
    doNotCall:
      "User has already given structured food name + macros — go straight to ``syntropy_log_food``. Or user is asking about past intake — use ``syntropy_health_snapshot``.",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_diet_gap",
    mcpToolName: "get_diet_gap",
    description:
      'Compare the user\'s actual macro intake vs ideal targets. Shows which macros (protein, carbs, fat, calories) are over or under their daily targets. Useful for "what should I eat next" recommendations.',
    scope: "consumer",
    whenToCall:
      'User asks "what am I missing", "am I getting enough protein", "what should I eat more of", or any macro-balance question.',
    doNotCall: "User wants an overall score, not a gap analysis — use ``syntropy_diet_score``.",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_diet_score",
    mcpToolName: "get_diet_score",
    description:
      "Get the user's diet fulfillment score over the last N days. Returns overall score (0-100), macro score, consistency score, and detailed breakdown. Aggregated from check-in + food-log history.",
    scope: "consumer",
    whenToCall:
      'User asks "how am I doing", "how\'s my diet", "what\'s my score", or any progress / fulfillment / adherence question over a time window.',
    doNotCall:
      "User wants the macro GAP (over/under targets) — use ``syntropy_diet_gap`` instead. Or for a full multi-axis health snapshot — use ``syntropy_health_snapshot``.",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_health_profile",
    mcpToolName: "get_health_profile",
    description:
      "Get the user's health profile — dietary preferences, goals, conditions, allergies, and supplement stack. Static-ish context; cache aggressively on the agent side.",
    scope: "consumer",
    whenToCall:
      "Once per session, ideally early — agent needs allergies + goals + conditions context before personalising any recommendation.",
    doNotCall: "Already called this session and the profile hasn't been edited.",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_health_snapshot",
    mcpToolName: "get_health_snapshot",
    description:
      "Get an aggregated health snapshot — food logs, symptoms, medications, and macro totals over the last N days. Single call that returns the multi-axis view; cheaper than calling diet_score + diet_gap + my_checkins separately.",
    scope: "consumer",
    whenToCall:
      'User asks for a summary, status, "how I\'m doing overall", multi-axis health check, or wants context before making a recommendation that touches multiple dimensions.',
    doNotCall:
      "User wants a single dimension (use ``syntropy_diet_score`` / ``syntropy_diet_gap``) or wants raw check-ins (use ``syntropy_my_checkins``).",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_log_checkin",
    mcpToolName: "log_checkin",
    description:
      'Record a daily health check-in from free-text content. The system extracts health events (symptoms, medications, mood, energy, sleep) automatically. Use for any wellness signal the user shares, even if not framed as a "check-in".',
    scope: "consumer",
    whenToCall:
      'User mentions mood, energy, sleep quality, symptoms, body signal, medication taken, or any "checking in" / "logging" semantics — even when the framing is casual.',
    doNotCall:
      "User is asking a question about past check-ins (use ``syntropy_my_checkins``) or wants to log a specific food item (use ``syntropy_log_food``).",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_log_food",
    mcpToolName: "log_food",
    description:
      "Log a food entry to your health journal. Captures the food name plus optional meal_type and macros (calories, protein, carbs, fat) into the user's check-in stream.",
    scope: "consumer",
    whenToCall:
      'User reports eating something — explicitly ("I had X for lunch") or descriptively ("just ate a salad"). Also use when extracting one food at a time from a multi-item meal description.',
    doNotCall:
      "User is asking ABOUT past food entries (use ``syntropy_my_checkins`` or ``syntropy_health_snapshot``) or wants nutritional breakdown of natural-language meal text (use ``syntropy_analyze_food``).",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_my_checkins",
    mcpToolName: "get_my_checkins",
    description:
      "Get the user's recent health check-ins (default 10, max 50). Returns the raw entries — agent must summarise.",
    scope: "consumer",
    whenToCall:
      'User asks about past check-ins explicitly ("what have I logged", "show my recent entries"). Or agent needs raw history before a pattern-finding task that the aggregated snapshot doesn\'t cover.',
    doNotCall:
      "User wants aggregated metrics — use ``syntropy_health_snapshot``, ``syntropy_diet_score``, or ``syntropy_diet_gap``.",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
  {
    name: "syntropy_my_protocols",
    mcpToolName: "get_my_protocols",
    description:
      "Get the wellness protocols the user is subscribed to. Returns active protocol subscriptions with adherence data.",
    scope: "consumer",
    whenToCall:
      "User asks about their subscribed protocols, supplement stack cadence, or active wellness regimens.",
    doNotCall:
      "User wants the broader health profile (allergies, conditions, goals) — use ``syntropy_health_profile``.",
    availableChannels: ["web", "mobile", "sms", "voice", "whatsapp", "telegram"],
  },
] as const satisfies readonly RosterEntry[];

/**
 * WIRE names — what the live SJ MCP server announces on `tools/list`.
 *
 * The live SJ server registers via FastMCP's bare `@mcp_server.tool()`
 * decorator with NO `name=` argument, so the announced name is the PYTHON
 * FUNCTION name (`get_diet_score`), not the manifest's agent-facing `name`
 * (`syntropy_diet_score`). (`registry.py` has an `attach()` path that WOULD
 * register under the manifest name — but its own comment records that
 * server.py has not flipped to it.)
 *
 * Currently UNCONSUMED in this repo: the dynamic-catalog roster filter that
 * consumes this set is deferred work — see SyntropyHealth-Applications#212.
 * When that filter lands, it must compare against THESE names; comparing
 * against the agent-facing names would drop 100% of the SJ surface.
 */
export type RosterWireName = (typeof TOOL_ROSTER)[number]["mcpToolName"];
export const ROSTER_WIRE_NAMES: readonly RosterWireName[] = TOOL_ROSTER.map((t) => t.mcpToolName);

/** Canonical tool names, as a union — the membership contract tools.ts is pinned to. */
export type RosterToolName = (typeof TOOL_ROSTER)[number]["name"];

/** Every rostered name, for runtime membership checks. */
export const ROSTER_TOOL_NAMES: readonly RosterToolName[] = TOOL_ROSTER.map((t) => t.name);
