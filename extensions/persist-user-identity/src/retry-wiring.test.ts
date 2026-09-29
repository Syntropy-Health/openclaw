/**
 * persist-user-identity RECOVERS after a failed boot-time init — without a restart.
 *
 * Proves behaviour, not just log wording: while the DB is down there is no
 * identity lookup and no new connect attempt inside the backoff window; once the
 * window passes and the DB is back, the next turn initialises schema + vault
 * detection ONCE and resolves identity. A plugin that latched the first error
 * (the old defect), or rebuilt the retry wrapper per hook (a connect storm),
 * fails here. Also pins that a FAILED vault probe is retried rather than being
 * read as "vault absent" (which used to force the plaintext token path).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

const db = vi.hoisted(() => ({ down: true, probes: 0, vaultProbeFails: 0 }));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  const sql = ((strings: TemplateStringsArray) => {
    if (/SELECT 1/.test(strings.join("?"))) {
      db.probes += 1;
      return db.down ? Promise.reject(new Error("connection refused")) : Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as { end: () => Promise<void> };
  sql.end = () => Promise.resolve();
  return {
    ...actual,
    createPgClient: vi.fn(() => sql),
    ensureUserSchema: vi.fn(async () => {}),
    findUserByChannelPeer: vi.fn(async () => null),
    autoBindVerifiedPeer: vi.fn(async () => {}),
  };
});

vi.mock("../../syntropy/src/vault.js", () => ({
  secretNameForUser: (userId: string) => `syntropy_user_${userId}`,
  createSyntropyVault: vi.fn(() => ({ tag: "vault" })),
  vaultRpcsInstalled: vi.fn(async () => {
    if (db.vaultProbeFails > 0) {
      db.vaultProbeFails -= 1;
      throw new Error("too many connections for role");
    }
    return true;
  }),
}));

function createMockApi() {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  const api = {
    _hooks: hooks,
    id: "persist-user-identity",
    name: "Persist User Identity",
    source: "test",
    config: {} as OpenClawPluginApi["config"],
    pluginConfig: { databaseUrl: "postgresql://mock/test" },
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
  vi.clearAllMocks(); // call counts must not carry over between tests
  db.down = true;
  db.probes = 0;
  db.vaultProbeFails = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  vi.resetModules();
  const dbmod = await import("./db.js");
  const vaultmod = await import("../../syntropy/src/vault.js");
  const { default: plugin } = await import("./index.js");
  const api = createMockApi();
  plugin.register(api);
  const hook = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
  const turn = () => hook({ prompt: "hi" }, { sessionKey: "agent:main:telegram:direct:user1" });
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
  return { api, dbmod, vaultmod, turn, advance };
}

describe("persist-user-identity — recovers after a failed init", () => {
  test("down: no lookup, no connect storm; back after the window: init once, then resolves identity", async () => {
    const { api, dbmod, turn, advance } = await setup();
    await turn();
    expect(db.probes).toBe(1);
    expect(dbmod.findUserByChannelPeer).not.toHaveBeenCalled();

    advance(999);
    await turn();
    expect(db.probes, "no new connect attempt inside the 1s window").toBe(1);

    db.down = false;
    advance(1);
    await turn();
    expect(db.probes).toBe(2);
    expect(dbmod.ensureUserSchema).toHaveBeenCalledTimes(1);
    expect(dbmod.findUserByChannelPeer).toHaveBeenCalledTimes(1);

    await turn();
    expect(db.probes, "ready: never re-probes").toBe(2);
    const errors = (api.logger.error as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(errors).toMatch(/persist-user-identity: init failed \(attempt 1, retry in 1s\)/);
    expect(errors).not.toContain("will not retry");
  });

  test("a FAILED vault probe is retried — never silently read as 'vault absent' (plaintext path)", async () => {
    db.down = false;
    db.vaultProbeFails = 1;
    const { api, vaultmod, turn, advance } = await setup();
    await turn(); // schema ok, vault probe throws -> init fails -> backoff
    const warns = (api.logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(warns).not.toContain("LEGACY PLAINTEXT");
    advance(1_000);
    await turn(); // retried: probe succeeds -> vault active
    expect(vaultmod.createSyntropyVault).toHaveBeenCalledTimes(1);
    const info = (api.logger.info as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(info).toContain("Syntropy token storage = supabase vault");
  });
});
