// SEALED challenge suite for SYN-206 Task 1 — formatProfileBlock pure formatter.
//
// Authored double-blind from the interface contract:
//   extensions/syntropy/docs/SYN-206-formatProfileBlock.contract.md
// The test-author never reads the implementation; the implementer never reads
// this suite. Coarse pass/fail flows to the implementer ONLY via the referee,
// aggregated by the top-level describe() name (the slash-namespaced category).
//
// RED until the implementer creates extensions/syntropy/src/profile.ts.
//
// Open questions for the principal (contract ambiguities — NOT invented behavior):
//  - The 200-char cap is asserted as: value rendered, then if length > 200 the
//    value is sliced to its first 200 chars and a single U+2026 is appended
//    (total visible length 201). Tested via length thresholds, not a hardcoded
//    expected string, to avoid overfitting the exact truncation index.

import { describe, it, expect } from "vitest";
import { formatProfileBlock } from "../../../extensions/syntropy/src/profile.js";

const OPEN = "[SYNTROPY_PROFILE]";
const CLOSE = "[/SYNTROPY_PROFILE]";

// A complete, well-formed success profile with all six fields populated.
function fullProfile() {
  return {
    allergies: ["peanuts", "shellfish"],
    conditions: ["hypertension"],
    health_goals: ["lose weight", "sleep better"],
    supplement_stack: ["magnesium", "vitamin d"],
    dietary_preferences: { style: "mediterranean", caffeine: "none" },
    metrics_data: { age: 41, sex: "M", height_cm: 180 },
  };
}

// Split a non-null block into its inner (between-marker) lines.
function lines(block: string): string[] {
  return block.split("\n");
}

describe("functional/formatter", () => {
  it("wraps the block in exact open/close markers as first and last lines", () => {
    const out = formatProfileBlock(fullProfile());
    expect(out).not.toBeNull();
    const ls = lines(out as string);
    expect(ls[0]).toBe(OPEN);
    expect(ls[ls.length - 1]).toBe(CLOSE);
  });

  it("renders each non-empty field as a single `<label>: <value>` line with exact labels", () => {
    const out = formatProfileBlock(fullProfile()) as string;
    expect(out).toContain("\nallergies: peanuts, shellfish\n");
    expect(out).toContain("\nconditions: hypertension\n");
    expect(out).toContain("\ngoals: lose weight, sleep better\n");
    expect(out).toContain("\nsupplements: magnesium, vitamin d\n");
  });

  it("joins string-array values with `, `", () => {
    const out = formatProfileBlock({
      allergies: ["a", "b", "c"],
    }) as string;
    const line = lines(out).find((l) => l.startsWith("allergies:"));
    expect(line).toBe("allergies: a, b, c");
  });

  it("renders object fields as key=value pairs joined with `, ` in input key order", () => {
    const out = formatProfileBlock({
      dietary_preferences: { style: "keto", red_meat: "no", dairy: "yes" },
    }) as string;
    const line = lines(out).find((l) => l.startsWith("diet:"));
    expect(line).toBe("diet: style=keto, red_meat=no, dairy=yes");
  });

  it("renders metrics_data with the `metrics` label and key=value pairs in key order", () => {
    const out = formatProfileBlock({
      metrics_data: { age: 41, sex: "M", height_cm: 180 },
    }) as string;
    const line = lines(out).find((l) => l.startsWith("metrics:"));
    expect(line).toBe("metrics: age=41, sex=M, height_cm=180");
  });

  it("each labelled line matches ^<label>: <value>$ exactly (no stray prefix/suffix)", () => {
    const out = formatProfileBlock(fullProfile()) as string;
    const inner = lines(out).slice(1, -1); // strip markers
    const labels = ["allergies", "conditions", "goals", "supplements", "diet", "metrics"];
    for (const l of inner) {
      const m = l.match(/^([a-z]+): (.+)$/);
      expect(m).not.toBeNull();
      expect(labels).toContain((m as RegExpMatchArray)[1]);
    }
    expect(inner).toHaveLength(6);
  });

  it("omits empty fields entirely when only some fields are populated", () => {
    const out = formatProfileBlock({
      conditions: ["asthma"],
      health_goals: ["run a 5k"],
    }) as string;
    const inner = lines(out).slice(1, -1);
    expect(inner).toEqual(["conditions: asthma", "goals: run a 5k"]);
    expect(out).not.toContain("allergies:");
    expect(out).not.toContain("supplements:");
    expect(out).not.toContain("diet:");
    expect(out).not.toContain("metrics:");
  });
});

describe("functional/envelope", () => {
  it("returns null for an { error } failure envelope", () => {
    expect(formatProfileBlock({ error: "not found" })).toBeNull();
  });

  it("returns null for a { type: 'paywall' } envelope", () => {
    expect(formatProfileBlock({ type: "paywall", plan: "pro" })).toBeNull();
  });

  it("returns null for null", () => {
    expect(formatProfileBlock(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(formatProfileBlock(undefined)).toBeNull();
  });

  it("returns null for a non-object (string)", () => {
    expect(formatProfileBlock("hello")).toBeNull();
  });

  it("returns null for a non-object (number)", () => {
    expect(formatProfileBlock(42)).toBeNull();
  });

  it("returns null when all six fields are present but empty", () => {
    expect(
      formatProfileBlock({
        allergies: [],
        conditions: [],
        health_goals: [],
        supplement_stack: [],
        dietary_preferences: {},
        metrics_data: {},
      }),
    ).toBeNull();
  });
});

describe("functional/normalization", () => {
  it("trims whitespace from array items", () => {
    const out = formatProfileBlock({ allergies: ["  peanuts ", " soy"] }) as string;
    const line = lines(out).find((l) => l.startsWith("allergies:"));
    expect(line).toBe("allergies: peanuts, soy");
  });

  it("drops non-string, empty, and whitespace-only array items", () => {
    const out = formatProfileBlock({
      allergies: ["peanuts", "", "   ", 7, null, undefined, "soy"],
    }) as string;
    const line = lines(out).find((l) => l.startsWith("allergies:"));
    expect(line).toBe("allergies: peanuts, soy");
  });

  it("omits a string-array field that becomes empty after cleaning", () => {
    const out = formatProfileBlock({
      allergies: ["", "   ", null],
      conditions: ["diabetes"],
    }) as string;
    expect(out).not.toContain("allergies:");
    expect(out).toContain("conditions: diabetes");
  });

  it("drops object entries whose value is null or undefined", () => {
    const out = formatProfileBlock({
      dietary_preferences: { style: "vegan", caffeine: null, alcohol: undefined, dairy: "no" },
    }) as string;
    const line = lines(out).find((l) => l.startsWith("diet:"));
    expect(line).toBe("diet: style=vegan, dairy=no");
  });

  it("omits an object field whose entries are all null/undefined", () => {
    const out = formatProfileBlock({
      metrics_data: { age: null, sex: undefined },
      conditions: ["asthma"],
    }) as string;
    expect(out).not.toContain("metrics:");
    expect(out).toContain("conditions: asthma");
  });

  it("treats missing or wrong-typed fields as empty without throwing", () => {
    expect(() =>
      formatProfileBlock({
        allergies: "not-an-array",
        conditions: 123,
        health_goals: { nope: true },
        supplement_stack: null,
        dietary_preferences: ["wrong"],
        metrics_data: "string",
      }),
    ).not.toThrow();
    // wrong-typed array fields contribute nothing; the object-field shapes here
    // carry no usable primitive entries, so the profile is effectively empty.
    const out = formatProfileBlock({
      allergies: "not-an-array",
      conditions: 123,
    });
    expect(out).toBeNull();
  });

  it("never throws for assorted malformed inputs", () => {
    const inputs: unknown[] = [
      {},
      { allergies: [{}, [], () => 1] },
      { dietary_preferences: null },
      { metrics_data: 0 },
      [],
      true,
      Symbol("x"),
      { error: undefined },
    ];
    for (const i of inputs) {
      expect(() => formatProfileBlock(i)).not.toThrow();
    }
  });
});

describe("functional/bounds", () => {
  it("caps an over-long array-field value at 200 chars + an ellipsis", () => {
    const huge = "x".repeat(500);
    const out = formatProfileBlock({ allergies: [huge] }) as string;
    const line = lines(out).find((l) => l.startsWith("allergies: ")) as string;
    const value = line.slice("allergies: ".length);
    expect([...value]).toHaveLength(201); // 200 chars + 1 ellipsis codepoint
    expect(value.endsWith("…")).toBe(true);
    expect(value.slice(0, 200)).toBe("x".repeat(200));
  });

  it("caps an over-long object-field value at 200 chars + an ellipsis", () => {
    const out = formatProfileBlock({
      dietary_preferences: { note: "y".repeat(500) },
    }) as string;
    const line = lines(out).find((l) => l.startsWith("diet: ")) as string;
    const value = line.slice("diet: ".length);
    expect([...value]).toHaveLength(201);
    expect(value.endsWith("…")).toBe(true);
  });

  it("does not append an ellipsis to a value at or under 200 chars", () => {
    const exact = "z".repeat(200);
    const out = formatProfileBlock({ allergies: [exact] }) as string;
    const line = lines(out).find((l) => l.startsWith("allergies: ")) as string;
    const value = line.slice("allergies: ".length);
    expect(value).toBe(exact);
    expect(value.includes("…")).toBe(false);
  });
});

describe("integration/order", () => {
  it("renders fields in the safety-critical order allergies < conditions < goals < supplements < diet < metrics", () => {
    const out = formatProfileBlock(fullProfile()) as string;
    const text = out;
    const idx = (label: string) => text.indexOf(`\n${label}:`);
    const allergies = idx("allergies");
    const conditions = idx("conditions");
    const goals = idx("goals");
    const supplements = idx("supplements");
    const diet = idx("diet");
    const metrics = idx("metrics");
    for (const i of [allergies, conditions, goals, supplements, diet, metrics]) {
      expect(i).toBeGreaterThan(-1);
    }
    expect(allergies).toBeLessThan(conditions);
    expect(conditions).toBeLessThan(goals);
    expect(goals).toBeLessThan(supplements);
    expect(supplements).toBeLessThan(diet);
    expect(diet).toBeLessThan(metrics);
  });

  it("places allergies and conditions before goals/supplements/diet/metrics", () => {
    const out = formatProfileBlock(fullProfile()) as string;
    const idx = (label: string) => out.indexOf(`\n${label}:`);
    const safety = [idx("allergies"), idx("conditions")];
    const later = [idx("goals"), idx("supplements"), idx("diet"), idx("metrics")];
    for (const s of safety) {
      for (const l of later) {
        expect(s).toBeLessThan(l);
      }
    }
  });

  it("keeps allergies before conditions even when intervening fields are absent", () => {
    const out = formatProfileBlock({
      conditions: ["c"],
      allergies: ["a"],
      metrics_data: { age: 30 },
    }) as string;
    const idx = (label: string) => out.indexOf(`\n${label}:`);
    expect(idx("allergies")).toBeLessThan(idx("conditions"));
    expect(idx("conditions")).toBeLessThan(idx("metrics"));
  });
});
