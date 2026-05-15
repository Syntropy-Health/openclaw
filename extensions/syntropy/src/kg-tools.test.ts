/**
 * KG-direct tool-factory tests.
 *
 * `createAllKgTools(kgBaseUrl, authToken)` must return exactly the 3
 * KG-direct MVP tools. The names + scope tags are load-bearing — they
 * match the manifest yamls (SYN-33 plan-of-record) and must stay aligned
 * with the shrine-diet-bioactivity kg-mcp server's tool registry.
 *
 * If a tool is renamed, dropped, or added, this test must be updated to
 * match — and the schema-coupling pipeline (#44) must propagate the
 * change to every consumer surface in the same PR.
 *
 * Mirrors `tools.test.ts` (the SJ tool factory tests) in pattern.
 */

import { describe, expect, it } from "vitest";
import { createAllKgTools } from "./kg-tools.js";

const EXPECTED_TOOL_NAMES = [
  "kg_food_to_bioactives",
  "kg_compound_lookup",
  "kg_contraindication_check",
] as const;

describe("createAllKgTools", () => {
  const tools = createAllKgTools("https://kg-mcp-test.up.railway.app", "sj_test_token");

  it("returns exactly 3 KG-direct tools", () => {
    expect(tools).toHaveLength(3);
  });

  it("exposes the 3 canonical KG-direct tool names", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("every tool has a non-empty label + description and a TypeBox object parameters schema", () => {
    for (const t of tools) {
      expect(t.label, `${t.name} label`).toBeTruthy();
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.description.length, `${t.name} description length`).toBeGreaterThan(10);
      expect(t.parameters, `${t.name} parameters`).toBeDefined();
      expect(t.parameters.type, `${t.name} parameters.type`).toBe("object");
    }
  });

  it("every tool carries the diet_kg:read scope tag (manifest contract)", () => {
    // The SYN-33 plan-of-record locks scope=diet_kg:read for all 3 MVP
    // tools. The manifest YAMLs in apps/openclaw/extensions/syntropy/
    // manifests/kg-direct/ encode this. Once the manifest-driven
    // codegen (PR #55) lands, this test will compare against that source
    // of truth. Until then, assert the field is wired through.
    for (const t of tools) {
      expect(t.scope, `${t.name} scope`).toBe("diet_kg:read");
    }
  });
});
