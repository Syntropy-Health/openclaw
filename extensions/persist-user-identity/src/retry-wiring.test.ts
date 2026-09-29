/**
 * Wiring check: persist-user-identity's init goes through createRetryingInit, so
 * a DB that is unreachable at boot is RETRIED (the retry contract itself is proven
 * with an injectable clock in src/plugin-sdk/retrying-init.test.ts). Before this,
 * the first failure was cached for the life of the process and identity binding
 * stayed off until a restart.
 */
import { describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

function createMockApi(pluginConfig: Record<string, unknown>) {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  const api = {
    _hooks: hooks,
    id: "persist-user-identity",
    name: "Persist User Identity",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig,
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    on: vi.fn((name: string, handler: (...a: unknown[]) => unknown) => {
      hooks.push({ name, handler });
    }),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
  };
  return api as unknown as OpenClawPluginApi & typeof api;
}

describe("persist-user-identity — init is retried, not cached forever", () => {
  test("an unreachable DB logs the failure with its retry delay (never 'will not retry')", async () => {
    const { default: plugin } = await import("./index.js");
    const api = createMockApi({ databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/nope" });
    plugin.register(api);

    const hook = api._hooks.find((h) => h.name === "before_agent_start");
    expect(hook, "before_agent_start registered").toBeDefined();
    await hook!.handler({ prompt: "hi" }, { sessionKey: "agent:main:telegram:direct:user1" });

    const errors = (api.logger.error as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(errors).toMatch(/persist-user-identity: init failed \(attempt 1, retry in 1s\)/);
    expect(errors).not.toContain("will not retry");
  }, 30_000);
});
