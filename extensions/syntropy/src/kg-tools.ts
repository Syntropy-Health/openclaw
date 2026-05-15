/**
 * KG-direct tool definitions for the OpenClaw agent.
 *
 * 3 tools that the agent can call directly against shrine-diet-bioactivity's
 * kg-mcp instance, using the same `sj_*` ApiToken (from Supabase Vault) the
 * extension already manages for SJ MCP. ADR-001 §5 says metering happens
 * atomically inside each kg-mcp tool handler via `quota_check_and_debit` —
 * the extension does NOT pre-call any metering RPC.
 *
 * Hand-rolled TypeBox schemas for now; KG response codegen (Phase A of
 * SYN-33) will replace them with generated types from `shared/schemas/
 * models/kg/*.schema.json`. The 3 tool names are load-bearing per the
 * manifest yamls (`apps/openclaw/extensions/syntropy/manifests/kg-direct/`)
 * and the SYN-33 plan-of-record acceptance criteria.
 *
 * Scope tag (`diet_kg:read`) is a manifest-driven authz hint. Per ADR-001
 * §2, the actual auth happens at kg-mcp via Unkey-verified Bearer; the
 * scope is descriptive metadata for the manifest plan (PR #55).
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type, type TObject } from "@sinclair/typebox";
import { callKgTool, type KgToolResult } from "./kg-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toAgentResult(res: KgToolResult): AgentToolResult<unknown> {
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

interface KgToolDef {
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  scope: "diet_kg:read";
  mcpToolName: string;
}

// ---------------------------------------------------------------------------
// Tool definitions — 3 KG-direct MVP tools
// ---------------------------------------------------------------------------

const TOOL_DEFS: KgToolDef[] = [
  {
    name: "kg_food_to_bioactives",
    label: "Food → Bioactives",
    mcpToolName: "food_to_bioactives",
    scope: "diet_kg:read",
    description:
      "Look up the bioactive compound profile of a food (anthocyanins, polyphenols, " +
      "carotenoids, etc.) for mechanism-of-action explanations and cross-reference. " +
      "Returns compound list with mg-per-serving and source citation.",
    parameters: Type.Object({
      food_name: Type.String({ description: "Food name or description (e.g. 'blueberries')" }),
      max_results: Type.Optional(
        Type.Number({ description: "Max bioactives to return (default 20, hard cap 50)" }),
      ),
    }),
  },
  {
    name: "kg_compound_lookup",
    label: "Compound Lookup",
    mcpToolName: "compound_lookup",
    scope: "diet_kg:read",
    description:
      "Look up a bioactive compound's canonical profile: synonyms, pharmacology summary, " +
      "typical dosage range. Useful when the user asks about a specific compound or for " +
      "supplement-stack reasoning.",
    parameters: Type.Object({
      compound_name: Type.String({
        description: "Compound name (canonical or synonym, e.g. 'curcumin')",
      }),
    }),
  },
  {
    name: "kg_contraindication_check",
    label: "Contraindication Check",
    mcpToolName: "contraindication_check",
    scope: "diet_kg:read",
    description:
      "Multi-pair check for known interactions between a user's supplements and " +
      "medications. Returns severity-tagged warnings with mechanism citations. Call " +
      "BEFORE recommending a supplement or when the user adds a new medication.",
    parameters: Type.Object({
      supplements: Type.Array(Type.String(), {
        description: "Supplement names the user is taking or considering",
      }),
      medications: Type.Array(Type.String(), {
        description: "Medication names the user is currently on",
      }),
    }),
  },
];

// ---------------------------------------------------------------------------
// Factory — creates tools bound to a specific user's kg-mcp URL + sj_*
// ---------------------------------------------------------------------------

export function createAllKgTools(
  kgBaseUrl: string,
  authToken: string,
): Array<{
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  scope: "diet_kg:read";
  execute: (toolCallId: string, args: unknown) => Promise<AgentToolResult<unknown>>;
}> {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    scope: def.scope,
    async execute(_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> {
      const params = (args ?? {}) as Record<string, unknown>;
      const result = await callKgTool(kgBaseUrl, authToken, def.mcpToolName, params);
      return toAgentResult(result);
    },
  }));
}
