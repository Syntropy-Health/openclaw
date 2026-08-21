/**
 * #200 surface 2 — "DISCOVERY IS NOT AUTHORITY" (CTO ruling).
 *
 * The dynamic catalog serves whatever an MCP server reports. That makes the
 * SERVER'S RUNTIME BEHAVIOUR the contract, which inverts F.1 (declare, then
 * generate) into observe-then-serve. The ruling: the manifest governs both
 * surfaces, so discovery is filtered against the declared roster.
 *
 * THE ACCEPTANCE BAR IS NOT "IT PASSES." The CTO's requirement, and the reason
 * this file exists separately: *"a guard not yet observed producing a red
 * verdict is unproven."* Every test below asserts the guard FIRES on a real
 * disagreement — a silent filter and a correct filter are indistinguishable
 * from the served set alone, which is the very failure being fixed.
 */

import { describe, expect, it, vi } from "vitest";
import type { McpToolDescriptor, McpToolListResult } from "../../syntropy/src/client.js";
import { type McpServerConfig, ToolCatalog } from "./catalog.js";

function server(id: string): McpServerConfig {
  return {
    id,
    baseUrl: `http://${id}.local`,
    getToken: () => Promise.resolve(`${id}_token`),
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Discovery stub keyed by server id, mirroring catalog.test.ts's shape. */
function listToolsReturning(byServer: Record<string, string[]>) {
  return vi.fn(async (baseUrl: string): Promise<McpToolListResult> => {
    const id = baseUrl.includes("kg.local") ? "kg" : "sj";
    const tools: McpToolDescriptor[] = (byServer[id] ?? []).map((name) => ({
      name,
      description: `${name} tool`,
    }));
    return { ok: true, tools };
  });
}

/**
 * WIRE names, deliberately — this is what the live SJ server announces.
 *
 * The first version of this file used agent-facing names (`syntropy_log_food`)
 * and would have passed while the production filter dropped 100% of the SJ
 * surface: the live server registers with FastMCP's bare `@mcp_server.tool()`
 * decorator (no `name=`), so it announces the PYTHON FUNCTION name. Matches the
 * convention already used by catalog.test.ts and index.test.ts.
 */
const DECLARED = ["log_food", "get_diet_score"] as const;

describe("#200 — discovered-but-undeclared is FILTERED and REPORTED", () => {
  it("drops an undeclared tool from the agent surface", async () => {
    const log = makeLog();
    const catalog = new ToolCatalog([server("sj")], {
      log,
      // chat_with_shrine is the real case: deprecated in the manifest but kept
      // live by SJ's DEPRECATED_STILL_LIVE, so discovery still reports it.
      listTools: listToolsReturning({
        sj: ["log_food", "get_diet_score", "chat_with_shrine"],
      }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    const names = catalog.getToolDescriptors().map((e) => e.descriptor.name);
    expect(names).toContain("log_food");
    expect(names).not.toContain("chat_with_shrine");
  });

  it("WARNS about it — the guard must be observed firing, not merely silent", async () => {
    const log = makeLog();
    const catalog = new ToolCatalog([server("sj")], {
      log,
      listTools: listToolsReturning({
        sj: ["log_food", "get_diet_score", "chat_with_shrine"],
      }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();
    catalog.getToolDescriptors();

    const warned = log.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toMatch(/ROSTER DRIFT/);
    expect(warned).toMatch(/chat_with_shrine/);
  });

  it("reports it as structured drift, so a check can count it", async () => {
    const catalog = new ToolCatalog([server("sj")], {
      log: makeLog(),
      listTools: listToolsReturning({
        sj: ["log_food", "get_diet_score", "chat_with_shrine"],
      }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    expect(catalog.getRosterDrift()).toEqual([
      { serverId: "sj", kind: "discovered_undeclared", toolName: "chat_with_shrine" },
    ]);
  });
});

describe("#200 — declared-but-undiscovered is reported (the worse direction)", () => {
  it("flags a manifest tool the server does not serve", async () => {
    // This one cannot be filtered — the manifest promises a tool that will fail
    // at CALL time. Nothing else in the system notices until an agent tries it.
    const catalog = new ToolCatalog([server("sj")], {
      log: makeLog(),
      listTools: listToolsReturning({ sj: ["log_food"] }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    expect(catalog.getRosterDrift()).toEqual([
      { serverId: "sj", kind: "declared_undiscovered", toolName: "get_diet_score" },
    ]);
  });
});

describe("#200 — the filter is SCOPED, and over-broad application is the failure to avoid", () => {
  it("does NOT filter a server the roster does not govern", async () => {
    // The manifest describes SJ only. Applying an SJ-derived roster to the kg
    // server would silently delete its entire tool set — a correct rule applied
    // too widely, which is its own defect.
    const catalog = new ToolCatalog([server("sj"), server("kg")], {
      log: makeLog(),
      listTools: listToolsReturning({
        sj: ["log_food", "get_diet_score"],
        kg: ["kg_search", "kg_ingest"],
      }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    const names = catalog.getToolDescriptors().map((e) => e.descriptor.name);
    expect(names).toContain("kg_search");
    expect(names).toContain("kg_ingest");
  });

  it("is INERT when no roster is configured (existing callers unaffected)", async () => {
    const catalog = new ToolCatalog([server("sj")], {
      log: makeLog(),
      listTools: listToolsReturning({ sj: ["anything_at_all", "chat_with_shrine"] }),
    });
    await catalog.refresh();

    expect(catalog.getToolDescriptors().map((e) => e.descriptor.name)).toEqual([
      "anything_at_all",
      "chat_with_shrine",
    ]);
    expect(catalog.getRosterDrift()).toEqual([]);
  });
});

describe("#200 — a synced server produces NO drift (the guard must not cry wolf)", () => {
  it("reports nothing when declared and discovered agree", async () => {
    const log = makeLog();
    const catalog = new ToolCatalog([server("sj")], {
      log,
      listTools: listToolsReturning({ sj: [...DECLARED] }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    expect(catalog.getToolDescriptors()).toHaveLength(2);
    expect(catalog.getRosterDrift()).toEqual([]);
    expect(log.warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/ROSTER DRIFT/);
  });
});

describe("#200 — misconfiguration FAILS CLOSED (QG security finding 3)", () => {
  it("refuses to construct when declaredRosterServerId names no configured server", () => {
    // A typo would otherwise disable the filter silently AND make
    // getRosterDrift() return [] — a clean bill of health the config has not
    // earned, which is the failure mode the guard exists to prevent.
    expect(
      () =>
        new ToolCatalog([server("sj")], {
          log: makeLog(),
          listTools: listToolsReturning({ sj: ["log_food"] }),
          declaredRoster: DECLARED,
          declaredRosterServerId: "sj-typo",
        }),
    ).toThrow(/not among the configured servers/);
  });

  it("constructs normally when the id does match", () => {
    expect(
      () =>
        new ToolCatalog([server("sj")], {
          log: makeLog(),
          listTools: listToolsReturning({ sj: ["log_food"] }),
          declaredRoster: DECLARED,
          declaredRosterServerId: "sj",
        }),
    ).not.toThrow();
  });
});

describe("#200 — the roster filter compares WIRE names (QG security finding 2)", () => {
  /**
   * REGRESSION GUARD for the bug this suite originally hid. The generated
   * roster exports two namespaces; filtering against the agent-facing one
   * (`syntropy_*`) drops every SJ tool, because the live server announces
   * python function names. This test fails if anyone swaps the sets back.
   */
  it("does NOT drop real SJ tools when the server announces function names", async () => {
    const { ROSTER_WIRE_NAMES } =
      await import("../../syntropy/src/generated/tool-roster.generated.js");
    const catalog = new ToolCatalog([server("sj")], {
      log: makeLog(),
      // Exactly what the live server announces, per server.py's bare
      // @mcp_server.tool() decorators.
      listTools: listToolsReturning({
        sj: ["get_diet_score", "log_food", "get_health_snapshot"],
      }),
      declaredRoster: ROSTER_WIRE_NAMES,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    const names = catalog.getToolDescriptors().map((e) => e.descriptor.name);
    expect(names).toEqual(["get_diet_score", "log_food", "get_health_snapshot"]);
    expect(catalog.getRosterDrift().filter((d) => d.kind === "discovered_undeclared")).toEqual([]);
  });
});
