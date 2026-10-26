/**
 * Behavioural wiring for CTO #16865 (2): the REAL before_agent_start hook picks
 * the data-gate copy from the turn's channel as the gateway reports it
 * (`ctx.messageProvider`), not from the session key.
 *
 * HTTP turns carry session keys like `agent:main:openresponses-user:<scope>`,
 * whose derived channel is "openresponses-user" — NOT an HTTP gate channel. A
 * hook that read the channel from the session key alone would put the `!verify`
 * copy back on mobile, which is the bug being fixed (review finding, 658694335).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

// Every query returns no rows, so the user resolves as UNPAIRED.
vi.mock("postgres", () => {
  const sql = (() => Promise.resolve([])) as unknown as { end: () => Promise<void> };
  sql.end = () => Promise.resolve();
  return { default: () => sql };
});
vi.mock("./db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db.js")>()),
  ensureSyntropySchema: vi.fn(async () => {}),
}));
vi.mock("./vault.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault.js")>()),
  createSyntropyVault: vi.fn(() => ({ get: vi.fn(async () => null) })),
  vaultRpcsInstalled: vi.fn(async () => true),
}));

function createMockApi() {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  const api = {
    _hooks: hooks,
    id: "syntropy",
    name: "Syntropy",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: { syntropyBaseUrl: "https://sj.example.test", databaseUrl: "postgres://mock/db" },
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

async function fireHook(ctx: Record<string, unknown>) {
  vi.resetModules();
  const mod = await import("./index.js");
  const api = createMockApi();
  await mod.default.register(api);
  await new Promise((r) => setTimeout(r, 0));
  const hook = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
  const res = (await hook({ prompt: "hi" }, ctx)) as { prependContext?: string };
  return { res, mod, api };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syntropy before_agent_start — gate copy follows the turn's channel", () => {
  test.each(["shrinemobile", "webchat"])(
    "an unpaired HTTP (%s) turn with an openresponses-user session key gets the HTTP copy",
    async (provider) => {
      const { res, mod } = await fireHook({
        sessionKey: "agent:main:openresponses-user:u1",
        messageProvider: provider,
      });
      expect(res.prependContext).toBe(mod.SYNTROPY_GATE_HTTP);
      expect(res.prependContext).not.toMatch(/[!/]\s*verify/i);
    },
  );

  test("control: an unpaired messaging turn still gets the !verify copy", async () => {
    const { res, mod } = await fireHook({
      sessionKey: "agent:main:telegram:direct:user1",
      messageProvider: "telegram",
    });
    expect(res.prependContext).toBe(mod.SYNTROPY_GATE);
  });
});
