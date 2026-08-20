/**
 * Tool-factory tests.
 *
 * `createAllTools(baseUrl, authToken)` must return exactly the 9 health
 * tools registered with the SJ MCP server. The names + `MealType` enum
 * shape are load-bearing — the SJ MCP server validates against these
 * exactly, and chrome-shrine + mobile + shrine-diet-bioactivity consume
 * the same canonical contract via shared JSON Schema (see #44).
 *
 * If a tool is renamed, dropped, or added, this test must be updated to
 * match — and the schema-coupling pipeline (#44) must propagate the
 * change to every consumer surface in the same PR.
 */

import { describe, expect, it } from "vitest";
import { ROSTER_TOOL_NAMES } from "./generated/tool-roster.generated.js";
import { createAllTools } from "./tools.js";

/**
 * Mirrors `NOT_YET_IMPLEMENTED` in tools.ts. Kept in sync BY THE COMPILER
 * there (a rostered tool must be implemented or listed), so this set only has
 * to name the same deferrals; if it drifts, the length assertion below fails
 * loudly rather than silently passing.
 */
const NOT_YET_IMPLEMENTED_NAMES = new Set<string>([
  "syntropy_my_protocols",
  "syntropy_peptide_intake_set_fields",
]);

/**
 * #200 — DERIVED, not hand-listed.
 *
 * This was a hardcoded list of 9 that included `syntropy_chat`, a tool
 * `deprecated: true` upstream. So the test asserted the very divergence #200
 * exists to remove, and would have gone RED on the fix — a test encoding the
 * defect as the expectation.
 *
 * It now derives from the generated roster minus the explicitly-deferred
 * tools, which is the same contract `tools.ts` is compile-gated against. A tool
 * added or deprecated upstream flows through here automatically; it cannot go
 * stale independently, because there is no longer an independent copy.
 */
const EXPECTED_TOOL_NAMES: readonly string[] = ROSTER_TOOL_NAMES.filter(
  (n) => !NOT_YET_IMPLEMENTED_NAMES.has(n),
);

describe("createAllTools", () => {
  const tools = createAllTools("http://localhost:3000", "sj_test_token");

  it("returns exactly the rostered, implemented tools", () => {
    // Not a magic number: the count follows the generated roster.
    expect(tools).toHaveLength(EXPECTED_TOOL_NAMES.length);
    // Guard the guard — if the roster were empty this would pass vacuously.
    expect(EXPECTED_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  it("does NOT expose tools deprecated upstream (regression: syntropy_chat)", () => {
    // syntropy_chat is deprecated: true in the SJ manifest, so it must never
    // reach the agent surface again.
    expect(tools.map((t) => t.name)).not.toContain("syntropy_chat");
  });

  it("exposes exactly the canonical Syntropy tool names", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every tool has a non-empty label and description", () => {
    for (const t of tools) {
      expect(t.label, `${t.name} label`).toBeTruthy();
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.label.length, `${t.name} label length`).toBeGreaterThan(0);
      expect(t.description.length, `${t.name} description length`).toBeGreaterThan(10);
    }
  });

  it("every tool exposes a TypeBox object parameters schema", () => {
    for (const t of tools) {
      expect(t.parameters, `${t.name} parameters`).toBeDefined();
      expect(t.parameters.type, `${t.name} parameters.type`).toBe("object");
    }
  });

  it("syntropy_log_food encodes the canonical MealType enum (6 values)", () => {
    const tool = tools.find((t) => t.name === "syntropy_log_food");
    expect(tool, "log_food tool present").toBeDefined();
    const mealProp = (tool!.parameters as { properties: Record<string, unknown> }).properties
      ?.meal_type as { anyOf?: Array<{ const: string }> } | undefined;

    // Assert the schema shape unconditionally. If codegen ever switches the
    // generated MealTypeSchema from `Type.Union([Type.Literal(...)])` (which
    // emits `{ anyOf: [...] }`) to e.g. `Type.String({ enum: [...] })` (which
    // emits `{ enum: [...], type: "string" }`), this drift guard must FAIL
    // LOUD — not silently pass with `anyOf` undefined.
    expect(mealProp, "meal_type schema missing — codegen drift").toBeDefined();
    expect(
      mealProp?.anyOf,
      "meal_type must be a TypeBox Union (anyOf shape) — if this fails, the generator " +
        "in shared/schemas/scripts/generate-typebox-enums.mjs has drifted away from Type.Union",
    ).toBeDefined();

    const values = mealProp!.anyOf!.map((v) => v.const).sort();
    expect(values).toEqual(
      ["beverage", "breakfast", "dinner", "lunch", "snack", "supplement"].sort(),
    );
  });
});
