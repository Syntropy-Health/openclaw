/** mono #538: shortCircuitReply merge rule — optional, first defined (higher priority) wins. */
import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "./registry.js";
import type { PluginHookBeforeAgentStartResult, TypedPluginHookRegistration } from "./types.js";

function add(
  registry: PluginRegistry,
  id: string,
  result: PluginHookBeforeAgentStartResult,
  priority: number,
) {
  registry.typedHooks.push({
    pluginId: id,
    hookName: "before_agent_start",
    handler: () => result,
    priority,
    source: "test",
  } as TypedPluginHookRegistration);
}

const ctx = { agentId: "a", sessionKey: "sk", sessionId: "sid", workspaceDir: "/tmp" };

describe("before_agent_start shortCircuitReply merge (mono #538)", () => {
  it("is absent unless a hook sets it", async () => {
    const registry = createEmptyPluginRegistry();
    add(registry, "identity", { prependContext: "A" }, 60);
    add(registry, "gate", { prependContext: "B" }, 40);
    const r = await createHookRunner(registry).runBeforeAgentStart({ prompt: "p" }, ctx);
    expect(r?.shortCircuitReply).toBeUndefined();
    expect(r?.prependContext).toBe("A\n\nB");
  });

  it("is carried through when a lower-priority hook sets it", async () => {
    const registry = createEmptyPluginRegistry();
    add(registry, "identity", { prependContext: "A" }, 60);
    add(registry, "gate", { shortCircuitReply: "GATE" }, 40);
    const r = await createHookRunner(registry).runBeforeAgentStart({ prompt: "p" }, ctx);
    expect(r?.shortCircuitReply).toBe("GATE");
  });

  it("the higher-priority hook's value wins", async () => {
    const registry = createEmptyPluginRegistry();
    add(registry, "high", { shortCircuitReply: "HIGH" }, 90);
    add(registry, "low", { shortCircuitReply: "LOW" }, 10);
    const r = await createHookRunner(registry).runBeforeAgentStart({ prompt: "p" }, ctx);
    expect(r?.shortCircuitReply).toBe("HIGH");
  });
});
