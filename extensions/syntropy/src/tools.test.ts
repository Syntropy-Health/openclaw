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

import { describe, expect, it, vi } from "vitest";
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
      // #214: the propagated fields, verbatim from the roster.
      expect(def.whenToCall, `${def.name} whenToCall`).toBe(roster!.whenToCall);
      expect(def.doNotCall, `${def.name} doNotCall`).toBe(roster!.doNotCall);
      expect(def.availableChannels, `${def.name} channels`).toEqual(roster!.availableChannels);
    }
  });

  it("#214: the AGENT-facing description is COMPOSED — description + both hints (D4)", () => {
    const tools = createAllTools("http://x", "t");
    for (const def of TOOL_DEFS) {
      const agent = tools.find((t) => t.name === def.name)!;
      expect(agent.description, def.name).toBe(
        `${def.description} When to call: ${def.whenToCall} Do not call: ${def.doNotCall}`,
      );
      // The do-not-call half is the point (negative routing guidance) —
      // assert its presence independently so a composition refactor cannot
      // silently drop it while keeping the string non-empty.
      expect(agent.description, def.name).toContain("Do not call:");
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

  it("EVERY tool embedding meal_type encodes the canonical MealType enum (6 values)", () => {
    // QG2-3/T8: the first version guarded log_food only; analyze_food's
    // embedded enum was unguarded, which is part of why the gutted-schema
    // mutant (M5) survived. Iterate every embedder and pin the count.
    const embedders = tools.filter(
      (t) => (t.parameters as { properties?: Record<string, unknown> }).properties?.meal_type,
    );
    expect(
      embedders.map((t) => t.name).sort(),
      "exactly these tools embed meal_type — a dropped MealTypeSchema reference must fail here",
    ).toEqual(["syntropy_analyze_food", "syntropy_log_food"]);

    for (const tool of embedders) {
      const mealProp = (tool.parameters as { properties: Record<string, unknown> }).properties
        .meal_type as { anyOf?: Array<{ const: string }> };
      // Assert the shape unconditionally. If codegen ever switches the
      // generated MealTypeSchema from `Type.Union([Type.Literal(...)])` (which
      // emits `{ anyOf: [...] }`) to e.g. `Type.String({ enum: [...] })`, this
      // drift guard must FAIL LOUD — not silently pass with `anyOf` undefined.
      expect(
        mealProp.anyOf,
        `${tool.name}: meal_type must be a TypeBox Union (anyOf shape) — if this fails, ` +
          "shared/schemas/scripts/generate-typebox-enums.mjs has drifted away from Type.Union",
      ).toBeDefined();
      const values = mealProp.anyOf!.map((v) => v.const).sort();
      expect(values, tool.name).toEqual(
        ["beverage", "breakfast", "dinner", "lunch", "snack", "supplement"].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// QG2-3 — the LOCAL half of the join is pinned per tool, HARDCODED.
//
// The compile gate proves every implemented tool has *a* local entry of the
// right TYPE; it cannot prove the entry is the right CONTENT for that tool.
// Mutation-proven (QG 2026-08-21): swapping two tools' locals (M4) and
// gutting six parameter schemas + junking labels (M5) both passed tsgo AND
// the entire suite. This pin map is what kills that class. Deliberately
// hardcoded — deriving it from TOOL_LOCALS would compare the code to itself.
// ---------------------------------------------------------------------------

const LOCAL_PINS: Record<string, { label: string; props: string[]; required: string[] }> = {
  syntropy_log_food: {
    label: "Log Food",
    props: ["food_name", "meal_type", "calories", "protein", "carbs", "fat", "notes"],
    required: ["food_name"],
  },
  syntropy_log_checkin: {
    label: "Health Check-in",
    props: ["content"],
    required: ["content"],
  },
  syntropy_diet_score: { label: "Diet Score", props: ["days"], required: [] },
  syntropy_diet_gap: { label: "Diet Gap Analysis", props: ["days"], required: [] },
  syntropy_health_snapshot: { label: "Health Snapshot", props: ["days"], required: [] },
  syntropy_analyze_food: {
    label: "Analyze Food",
    props: ["food_text", "meal_type"],
    required: ["food_text"],
  },
  syntropy_health_profile: { label: "Health Profile", props: [], required: [] },
  syntropy_my_checkins: { label: "Recent Check-ins", props: ["limit"], required: [] },
};

describe("QG2-3 — per-tool pin of the hand-kept fields (label + parameter shape)", () => {
  it("the pin map covers exactly the implemented tool set (no tool can dodge the pin)", () => {
    expect(Object.keys(LOCAL_PINS).sort()).toEqual(TOOL_DEFS.map((d) => d.name).sort());
  });

  it("every tool's label and parameter keys match its pin (kills the swapped-locals mutant)", () => {
    for (const def of TOOL_DEFS) {
      const pin = LOCAL_PINS[def.name];
      expect(pin, `${def.name} missing from LOCAL_PINS`).toBeDefined();
      expect(def.label, `${def.name} label`).toBe(pin.label);
      const params = def.parameters as unknown as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(params.properties ?? {}).sort(), `${def.name} parameter keys`).toEqual(
        [...pin.props].sort(),
      );
      expect((params.required ?? []).slice().sort(), `${def.name} required keys`).toEqual(
        [...pin.required].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// QG2-12 — execute() actually dials the WIRE name.
//
// Before this block, the only assertion anywhere that `mcpToolName` reaches
// the transport lived in tracer.test.ts (one tool, inside the optional
// Braintrust suite) — remove that feature and the wire-name guarantee
// vanished. Pattern mirrors tracer.test.ts: doMock + dynamic import.
// ---------------------------------------------------------------------------

describe("QG2-12 — execute() wire behavior", () => {
  async function withMockedClient(result: unknown) {
    vi.resetModules();
    const callSyntropyTool = vi.fn(async (..._args: unknown[]) => result);
    vi.doMock("./client.js", () => ({ callSyntropyTool }));
    const mod = await import("./tools.js");
    vi.doUnmock("./client.js");
    return { mod, callSyntropyTool };
  }

  it("EVERY tool's execute() calls the transport with its roster mcpToolName", async () => {
    const { mod, callSyntropyTool } = await withMockedClient({ ok: true, data: "fine" });
    const built = mod.createAllTools("http://sj.local", "tok_x");
    for (const def of mod.TOOL_DEFS) {
      callSyntropyTool.mockClear();
      const tool = built.find((t) => t.name === def.name)!;
      await tool.execute("call-1", { some: "arg" });
      expect(callSyntropyTool, def.name).toHaveBeenCalledWith(
        "http://sj.local",
        "tok_x",
        def.mcpToolName,
        {
          some: "arg",
        },
      );
      // The wire name is the roster's `function`, never the agent-facing name.
      expect(callSyntropyTool.mock.calls[0][2], def.name).not.toBe(def.name);
    }
  });

  it("nullish args coalesce to {} before hitting the wire", async () => {
    const { mod, callSyntropyTool } = await withMockedClient({ ok: true, data: "fine" });
    const built = mod.createAllTools("http://sj.local", "tok_x");
    await built[0].execute("call-2", undefined);
    expect(callSyntropyTool.mock.calls[0][3]).toEqual({});
  });

  it("transport errors surface as user-visible Error text with details", async () => {
    const { mod } = await withMockedClient({ ok: false, error: "boom" });
    const built = mod.createAllTools("http://sj.local", "tok_x");
    const res = await built[0].execute("call-3", {});
    expect(res.content[0]).toEqual({ type: "text", text: "Error: boom" });
    expect((res.details as { error: string }).error).toBe("boom");
  });

  it("object data is pretty-printed JSON; string data passes through unwrapped", async () => {
    const obj = await withMockedClient({ ok: true, data: { a: 1 } });
    const objRes = await obj.mod.createAllTools("http://x", "t")[0].execute("c", {});
    expect((objRes.content[0] as { text: string }).text).toBe(JSON.stringify({ a: 1 }, null, 2));

    const str = await withMockedClient({ ok: true, data: "plain text" });
    const strRes = await str.mod.createAllTools("http://x", "t")[0].execute("c", {});
    expect((strRes.content[0] as { text: string }).text).toBe("plain text");
  });
});
