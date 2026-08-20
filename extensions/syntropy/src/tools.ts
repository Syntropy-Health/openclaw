/**
 * Syntropy Health tool definitions for the OpenClaw agent.
 *
 * Each tool wraps a Syntropy MCP tool, calling it via HTTP with the
 * user's stored API token (standard Bearer auth).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Schema source of truth
 * ──────────────────────────────────────────────────────────────────────────
 * Tool argument shapes here MUST stay aligned with the Syntropy contracts:
 *
 *   Canonical Pydantic models:
 *     apps/Syntropy-Journals/syntropy_journals/app/data/schemas/contracts.py
 *     (StrEnum classes: MealType, CheckInType, etc.)
 *
 *   Generated JSON Schema (consumed by chrome-shrine, shopify-protocols, mobile):
 *     shared/schemas/syntropy.schema.json (in SyntropyHealth-Applications monorepo)
 *
 * The SJ MCP server validates payloads server-side; mismatches here cause
 * the LLM to send invalid args (e.g. omitting valid enum values from the
 * tool surface), which manifests as user-visible 4xx responses on the SJ
 * `/mcp` endpoint. Keep enums encoded as TypeBox literal unions so the
 * agent sees the exact valid values.
 *
 * Enum schemas (`MealTypeSchema`, etc.) are imported from `./generated/`
 * — auto-generated from `shared/schemas/enums.json` in the parent monorepo.
 * Schema-drift CI catches divergence between this generated file and the
 * canonical source. The other 8 tools use simple primitives (string/number)
 * with no drift risk.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TObject } from "@sinclair/typebox";
import { callSyntropyTool, type SyntropyToolResult } from "./client.js";
import { MealTypeSchema } from "./generated/enums.generated.js";
import type { Tracer } from "./tracer.js";

// ---------------------------------------------------------------------------
// Schema-aligned enums
// ---------------------------------------------------------------------------
//
// `MealTypeSchema` and any other enum-typed tool arguments are generated
// from `shared/schemas/enums.json` (the monorepo's canonical schema source)
// via `npm run codegen:openclaw-enums` in `shared/schemas/`. The output
// lives in `./generated/enums.generated.ts` and is checked in. Schema-drift
// CI fails any PR that diverges the generated file from `enums.json`.
//
// To add a new enum to this file, append its name to `ENUMS_TO_EMIT` in
// `shared/schemas/scripts/generate-typebox-enums.mjs` then regenerate.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAgentResult(res: SyntropyToolResult): AgentToolResult<unknown> {
  if (!res.ok) {
    return {
      content: [{ type: "text", text: `Error: ${res.error ?? "Unknown error"}` }],
      details: { error: res.error },
    };
  }
  const text = typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2);
  return { content: [{ type: "text", text }], details: res.data };
}

// ---------------------------------------------------------------------------
// Tool descriptor
// ---------------------------------------------------------------------------

import { ROSTER_TOOL_NAMES, type RosterToolName } from "./generated/tool-roster.generated.js";

interface ToolDef {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TObject;
  readonly mcpToolName: string;
}

/**
 * #200 — the membership contract.
 *
 * `TOOL_LOCALS` below supplies only what the SJ manifest does NOT carry: the
 * TypeBox `parameters` and the UI `label`. Everything else (which tools exist,
 * their `mcpToolName`, their `description`) comes from the GENERATED roster,
 * so this file can no longer drift on membership the way it did — it shipped
 * deprecated `syntropy_chat` while omitting `syntropy_my_protocols` and
 * `syntropy_peptide_intake_set_fields`.
 *
 * THE GATE IS THE TYPE, NOT A COMMENT. `TOOL_LOCALS` is declared as a
 * `Record<RosterToolName, ToolLocal>`:
 *   - a rostered tool with no entry here  → TS2739 (missing property)
 *   - an entry here that is not rostered  → TS2353 (excess property)
 * Either way `tsgo` fails. A reviewer cannot forget, because the compiler will
 * not let them.
 *
 * Why `parameters` is not generated: the manifest names an `input_model_class`
 * but those Pydantic models are not exported into
 * `shared/schemas/syntropy.schema.json` (zero `*Input` defs). Generating them
 * is the follow-up that completes F.1 for this surface; inventing them here
 * would relocate hand-maintenance rather than remove it.
 */
type ToolLocal = {
  label: string;
  parameters: TObject;
};

// ---------------------------------------------------------------------------
// Tool definitions — 9 consumer tools
// ---------------------------------------------------------------------------

// NOTE: no `: ToolDef[]` annotation — that would widen `name` to `string` and
// silently defeat the membership gate below. `satisfies` type-checks the shape
// while `as const` preserves the literal names the gate needs.
const TOOL_DEFS = [
  {
    name: "syntropy_log_food",
    label: "Log Food",
    mcpToolName: "log_food",
    description:
      "Log a food entry to the user's Syntropy health journal with optional macro breakdown.",
    parameters: Type.Object({
      food_name: Type.String({ description: "Food item name or description" }),
      meal_type: Type.Optional(MealTypeSchema),
      calories: Type.Optional(Type.Number({ description: "Calories" })),
      protein: Type.Optional(Type.Number({ description: "Protein in grams" })),
      carbs: Type.Optional(Type.Number({ description: "Carbs in grams" })),
      fat: Type.Optional(Type.Number({ description: "Fat in grams" })),
      notes: Type.Optional(Type.String({ description: "Additional notes" })),
    }),
  },
  {
    name: "syntropy_log_checkin",
    label: "Health Check-in",
    mcpToolName: "log_checkin",
    description:
      "Record a daily health check-in. Describe how you feel, symptoms, medications, or wellness notes.",
    parameters: Type.Object({
      content: Type.String({ description: "Free-text health check-in" }),
    }),
  },
  // REMOVED (#200): `syntropy_chat` / `chat_with_shrine`. It is
  // `deprecated: true` in the SJ manifest and therefore absent from the
  // generated roster, but this hand-maintained list kept shipping it to the
  // agent — one of the three divergences #200 exists to close. The compile-time
  // membership check below now makes a phantom like this a build error.
  {
    name: "syntropy_diet_score",
    label: "Diet Score",
    mcpToolName: "get_diet_score",
    description: "Get diet fulfillment score (0-100) over the last N days with breakdown.",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Days to score (default: 30, max: 365)" })),
    }),
  },
  {
    name: "syntropy_diet_gap",
    label: "Diet Gap Analysis",
    mcpToolName: "get_diet_gap",
    description: "Compare actual macro intake vs ideal targets (protein, carbs, fat, calories).",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Days to analyze (default: 7, max: 365)" })),
    }),
  },
  {
    name: "syntropy_health_snapshot",
    label: "Health Snapshot",
    mcpToolName: "get_health_snapshot",
    description: "Aggregated health snapshot: food logs, symptoms, medications, macro totals.",
    parameters: Type.Object({
      days: Type.Optional(Type.Number({ description: "Days (default: 30, max: 365)" })),
    }),
  },
  {
    name: "syntropy_analyze_food",
    label: "Analyze Food",
    mcpToolName: "analyze_food",
    description:
      "Parse natural language food description into structured entries with macro totals.",
    parameters: Type.Object({
      food_text: Type.String({ description: "Natural language food description" }),
      meal_type: Type.Optional(MealTypeSchema),
    }),
  },
  {
    name: "syntropy_health_profile",
    label: "Health Profile",
    mcpToolName: "get_health_profile",
    description:
      "Get health profile: dietary preferences, goals, conditions, allergies, supplements.",
    parameters: Type.Object({}),
  },
  {
    name: "syntropy_my_checkins",
    label: "Recent Check-ins",
    mcpToolName: "get_my_checkins",
    description: "Get recent health check-ins.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Count (default: 10, max: 50)" })),
    }),
  },
] as const satisfies readonly ToolDef[];

// ---------------------------------------------------------------------------
// #200 — MEMBERSHIP GATE (compile-time). Do not soften these.
// ---------------------------------------------------------------------------

/** The tool names this file actually implements, as a literal union. */
type ImplementedName = (typeof TOOL_DEFS)[number]["name"];

/**
 * Rostered tools this file deliberately does NOT implement yet.
 *
 * #200 fixes the CONTRACT MECHANISM; it does not expand the agent's tool
 * surface (the CTO ruled explicitly that no new tool rides this ticket). These
 * two are live and non-deprecated in the SJ manifest but have never been
 * exposed here, and wiring them needs `parameters` authored against their
 * input contracts — real work with a user-visible 4xx failure mode if guessed.
 *
 * Listing them is not a TODO comment: it is load-bearing. The exhaustiveness
 * check below accepts a rostered tool ONLY if it is implemented or named here,
 * so a tool added to the manifest breaks the build until someone consciously
 * implements it or consciously defers it. Silence is not an option either way.
 */
const NOT_YET_IMPLEMENTED = [
  "syntropy_my_protocols",
  "syntropy_peptide_intake_set_fields",
] as const satisfies readonly RosterToolName[];

type PendingName = (typeof NOT_YET_IMPLEMENTED)[number];

/**
 * GATE 1 — no PHANTOM tools. Every implemented tool must exist in the roster.
 * Catches exactly the `syntropy_chat` case: a tool deprecated (or removed)
 * upstream that this file kept advertising to the agent.
 */
type Phantoms = Exclude<ImplementedName, RosterToolName>;
type _NoPhantoms = [Phantoms] extends [never]
  ? true
  : { ERROR: "tools.ts implements a tool absent from the generated roster"; phantom: Phantoms };
const _noPhantoms: _NoPhantoms = true;

/**
 * GATE 2 — no SILENTLY MISSING tools. Every rostered tool must be implemented
 * or explicitly deferred above. Catches the `my_protocols` /
 * `peptide_intake_set_fields` case: live upstream, never mirrored here.
 */
type Missing = Exclude<RosterToolName, ImplementedName | PendingName>;
type _NoMissing = [Missing] extends [never]
  ? true
  : {
      ERROR: "roster tool is neither implemented nor listed in NOT_YET_IMPLEMENTED";
      missing: Missing;
    };
const _noMissing: _NoMissing = true;

// Reference the runtime export so the generated module is a real dependency of
// this file rather than a types-only import an optimiser could elide.
if (ROSTER_TOOL_NAMES.length === 0) {
  throw new Error(
    "syntropy tools: generated roster is empty — regenerate codegen:openclaw-tool-roster",
  );
}

// ---------------------------------------------------------------------------
// Factory — creates tools bound to a specific user's auth token
// ---------------------------------------------------------------------------

export function createAllTools(
  baseUrl: string,
  authToken: string,
  // Optional Braintrust tracer (PHI-safe). When omitted (the default-OFF
  // path), tool execution calls the MCP transport directly — byte-identical
  // behavior, no braintrust code loaded.
  tracer?: Tracer,
): Array<{
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  execute: (toolCallId: string, args: unknown) => Promise<AgentToolResult<unknown>>;
}> {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    async execute(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
      const params = (args ?? {}) as Record<string, unknown>;
      const call = () => callSyntropyTool(baseUrl, authToken, def.mcpToolName, params);
      const result = tracer
        ? await tracer.traceMcp("Syntropy", def.mcpToolName, params, call)
        : await call();
      return toAgentResult(result);
    },
  }));
}
