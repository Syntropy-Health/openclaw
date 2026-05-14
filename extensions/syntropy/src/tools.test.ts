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
import { createAllTools } from "./tools.js";

const EXPECTED_TOOL_NAMES = [
  "syntropy_log_food",
  "syntropy_log_checkin",
  "syntropy_chat",
  "syntropy_diet_score",
  "syntropy_diet_gap",
  "syntropy_health_snapshot",
  "syntropy_analyze_food",
  "syntropy_health_profile",
  "syntropy_my_checkins",
] as const;

describe("createAllTools", () => {
  const tools = createAllTools("http://localhost:3000", "sj_test_token");

  it("returns exactly 9 tools", () => {
    expect(tools).toHaveLength(9);
  });

  it("exposes the 9 canonical Syntropy tool names", () => {
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
    if (mealProp?.anyOf) {
      const values = mealProp.anyOf.map((v) => v.const).sort();
      expect(values).toEqual(
        ["beverage", "breakfast", "dinner", "lunch", "snack", "supplement"].sort(),
      );
    }
  });
});
