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

const DECLARED = ["syntropy_log_food", "syntropy_diet_score"] as const;

describe("#200 — discovered-but-undeclared is FILTERED and REPORTED", () => {
  it("drops an undeclared tool from the agent surface", async () => {
    const log = makeLog();
    const catalog = new ToolCatalog([server("sj")], {
      log,
      // chat_with_shrine is the real case: deprecated in the manifest but kept
      // live by SJ's DEPRECATED_STILL_LIVE, so discovery still reports it.
      listTools: listToolsReturning({
        sj: ["syntropy_log_food", "syntropy_diet_score", "chat_with_shrine"],
      }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    const names = catalog.getToolDescriptors().map((e) => e.descriptor.name);
    expect(names).toContain("syntropy_log_food");
    expect(names).not.toContain("chat_with_shrine");
  });

  it("WARNS about it — the guard must be observed firing, not merely silent", async () => {
    const log = makeLog();
    const catalog = new ToolCatalog([server("sj")], {
      log,
      listTools: listToolsReturning({
        sj: ["syntropy_log_food", "syntropy_diet_score", "chat_with_shrine"],
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
        sj: ["syntropy_log_food", "syntropy_diet_score", "chat_with_shrine"],
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
      listTools: listToolsReturning({ sj: ["syntropy_log_food"] }),
      declaredRoster: DECLARED,
      declaredRosterServerId: "sj",
    });
    await catalog.refresh();

    expect(catalog.getRosterDrift()).toEqual([
      { serverId: "sj", kind: "declared_undiscovered", toolName: "syntropy_diet_score" },
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
        sj: ["syntropy_log_food", "syntropy_diet_score"],
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
