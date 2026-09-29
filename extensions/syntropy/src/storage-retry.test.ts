/**
 * syntropy's schema + vault detection is RETRIED after a failure.
 *
 * It used to run once at register: if that single attempt failed (e.g. a
 * transient "too many connections for role"), `vault` stayed null for the life
 * of the process, so vault-stored tokens were unreadable and paired users looked
 * unpaired until a restart. Now a later lookup, after the backoff window,
 * retries detection and turns the vault on.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

const st = vi.hoisted(() => ({ vaultProbeFails: 1 }));

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
  vaultRpcsInstalled: vi.fn(async () => {
    if (st.vaultProbeFails > 0) {
      st.vaultProbeFails -= 1;
      throw new Error("too many connections for role");
    }
    return true;
  }),
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

beforeEach(() => {
  vi.clearAllMocks();
  st.vaultProbeFails = 1;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("syntropy — vault detection retried after a failed first attempt", () => {
  test("a failed probe at register is retried on a later lookup and turns the vault on", async () => {
    vi.resetModules();
    const vaultmod = await import("./vault.js");
    const { default: plugin } = await import("./index.js");
    const api = createMockApi();
    await plugin.register(api);
    await new Promise((r) => setTimeout(r, 0)); // let the eager attempt settle

    expect(vaultmod.createSyntropyVault).not.toHaveBeenCalled();
    const warns = api.logger.warn.mock.calls.flat().join("\n");
    expect(warns, "a failed probe must not be read as 'vault absent'").not.toContain(
      "legacy-plaintext",
    );

    vi.setSystemTime(new Date(Date.now() + 1_000));
    const hook = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
    await hook({ prompt: "hi" }, { sessionKey: "agent:main:telegram:direct:user1" });

    expect(vaultmod.createSyntropyVault).toHaveBeenCalledTimes(1);
    expect(api.logger.info.mock.calls.flat().join("\n")).toContain("vault=supabase");
  });
});
