/**
 * CTO #17480 condition (2): the summariser path fires NO plugin hook. Runs the
 * REAL adapter with the real core model resolution and auth; only the network
 * call (completeSimple) is stubbed. A spy is registered on every hook name.
 * If someone swaps the summariser back to the embedded agent runner, which fires
 * hooks unconditionally, this fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../src/plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import type { PluginHookName } from "../../../src/plugins/types.js";
import { SUMMARISER_TIMEOUT_MS } from "./generate.js";
import { createHighlightRunner } from "./runner.js";

const completeSimple = vi.hoisted(() =>
  vi.fn(async () => ({ content: [{ type: "text", text: '{"highlights":[]}' }] })),
);
vi.mock("@mariozechner/pi-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mariozechner/pi-ai")>()),
  completeSimple,
}));

const HOOK_NAME_SET = {
  before_agent_start: true,
  llm_input: true,
  llm_output: true,
  agent_end: true,
  before_compaction: true,
  after_compaction: true,
  before_reset: true,
  message_received: true,
  message_sending: true,
  message_sent: true,
  before_tool_call: true,
  after_tool_call: true,
  tool_result_persist: true,
  before_message_write: true,
  session_start: true,
  session_end: true,
  gateway_start: true,
  gateway_stop: true,
} satisfies Record<PluginHookName, true>;
/** Every hook name, kept exhaustive by the type above: a new hook fails to compile here. */
const HOOK_NAMES = Object.keys(HOOK_NAME_SET) as PluginHookName[];

describe("summariser runner fires no plugin hook", () => {
  const hookCalls: string[] = [];
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    state: process.env.OPENCLAW_STATE_DIR,
  };
  let stateDir = "";

  beforeAll(() => {
    // An empty state dir so no real auth profile on this machine is read, and a
    // dummy key that never leaves the process (the network call is stubbed).
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hl-hooks-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.ANTHROPIC_API_KEY = "test-dummy-key-not-real";
    const registry = createEmptyPluginRegistry();
    for (const hookName of HOOK_NAMES) {
      registry.typedHooks.push({
        pluginId: "hook-spy",
        hookName,
        handler: () => {
          hookCalls.push(hookName);
        },
        source: "test",
      } as unknown as ReturnType<typeof createEmptyPluginRegistry>["typedHooks"][number]);
    }
    initializeGlobalHookRunner(registry);
  });

  afterAll(() => {
    resetGlobalHookRunner();
    for (const [k, v] of [
      ["ANTHROPIC_API_KEY", saved.key],
      ["OPENCLAW_STATE_DIR", saved.state],
    ] as const) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("positive control: the spy registry does record a hook when one runs", async () => {
    const runner = getGlobalHookRunner();
    expect(runner?.hasHooks("before_agent_start")).toBe(true);
    await runner?.runBeforeAgentStart({ prompt: "x", messages: [] } as never, {} as never);
    expect(hookCalls).toEqual(["before_agent_start"]);
    hookCalls.length = 0;
  });

  it("one completion on an anthropic model, and zero hook calls", async () => {
    const cfg = { agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5" } } } };
    const run = createHighlightRunner({ cfg: cfg as never });
    const text = await run({
      provider: "anthropic",
      prompt: "facts",
      timeoutMs: SUMMARISER_TIMEOUT_MS,
    });
    expect(text).toBe('{"highlights":[]}');
    expect(completeSimple).toHaveBeenCalledTimes(1);
    const [model] = completeSimple.mock.calls[0] as unknown as [{ provider: string }];
    expect(model.provider).toBe("anthropic");
    expect(hookCalls).toEqual([]);
  });
});
