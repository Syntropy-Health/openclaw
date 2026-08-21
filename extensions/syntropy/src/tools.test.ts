/**
 * Tool-factory tests (#200).
 *
 * `createAllTools(baseUrl, authToken)` must return exactly the rostered,
 * implemented health tools. Membership + `mcpToolName` + `description` are
 * DERIVED from the generated roster (one source of truth, F.1 Layered); the
 * compile-time `Record<ImplementedName, ToolLocal>` gate in tools.ts enforces
 * the join. These tests pin the two things the compiler cannot:
 *
 *   1. that the runtime derivation actually happened (fields verbatim from
 *      the roster, not from any hand-kept copy), and
 *   2. that the DEFERRAL LIST is not a free parameter — deleting an
 *      implemented tool and deferring it compiles clean in both mirrors
 *      (QG test-review mutant, 2026-08-21), so the exact deferral contents
 *      are pinned HERE, deliberately hardcoded. Shrinking the agent surface
 *      must be a conscious edit to this file.
 */

import { describe, expect, it } from "vitest";
import { ROSTER_TOOL_NAMES, TOOL_ROSTER } from "./generated/tool-roster.generated.js";
import { createAllTools, NOT_YET_IMPLEMENTED, TOOL_DEFS } from "./tools.js";

/**
 * #200 — the deferral tripwire. HARDCODED on purpose; do not derive.
 *
 * The compile gate accepts ANY partition of the roster into implemented vs
 * deferred — it enforces consistency, not surface size. This assertion is
 * what makes "quietly move a tool to NOT_YET_IMPLEMENTED" a red test instead
 * of a green refactor. If you are editing this list, you are changing the
 * agent's tool surface: say so in the PR.
 */
it("NOT_YET_IMPLEMENTED is exactly the consciously-deferred set", () => {
  expect([...NOT_YET_IMPLEMENTED].sort()).toEqual(["syntropy_my_protocols"]);
});

const EXPECTED_TOOL_NAMES: readonly string[] = ROSTER_TOOL_NAMES.filter(
  (n) => !(NOT_YET_IMPLEMENTED as readonly string[]).includes(n),
);

describe("#200 — TOOL_DEFS is derived from the roster, verbatim", () => {
  it("implements exactly roster-minus-deferred (both directions)", () => {
    expect(TOOL_DEFS.map((d) => d.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every deferred name is actually rostered (a stale deferral is an error)", () => {
    for (const name of NOT_YET_IMPLEMENTED) {
      expect(ROSTER_TOOL_NAMES, `${name} deferred but not rostered`).toContain(name);
    }
  });

  it("mcpToolName and description come from the roster VERBATIM", () => {
    // The historical defect class: a hand-kept mcpToolName typo
    // ("log_food_TYPO") passed tsgo AND the whole suite (QG mutation proof,
    // 2026-08-21) because nothing bound the field to the manifest. Now the
    // field is derived; this asserts the derivation, entry by entry.
    const rosterByName = new Map(TOOL_ROSTER.map((t) => [t.name as string, t]));
    for (const def of TOOL_DEFS) {
      const roster = rosterByName.get(def.name);
      expect(roster, `${def.name} missing from roster`).toBeDefined();
      expect(def.mcpToolName, `${def.name} mcpToolName`).toBe(roster!.mcpToolName);
      expect(def.description, `${def.name} description`).toBe(roster!.description);
    }
  });
});

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
