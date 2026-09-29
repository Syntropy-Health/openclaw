/**
 * persist-postgres RECOVERS after a failed boot-time init — without a restart.
 *
 * The log-wording test only proves the helper is called. This proves the
 * behaviour: while the DB is down no message is persisted and no new connect
 * attempt is made inside the backoff window; once the window passes and the DB
 * is back, the very next turn initialises the schema ONCE and persists. A plugin
 * that latched the first error (the old defect), or rebuilt the retry wrapper on
 * every hook (a connect storm), fails here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

const db = vi.hoisted(() => ({ down: true, probes: 0 }));

vi.mock("./db.js", () => {
  const sql = ((strings: TemplateStringsArray) => {
    if (/SELECT 1/.test(strings.join("?"))) {
      db.probes += 1;
      return db.down ? Promise.reject(new Error("connection refused")) : Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as { end: () => Promise<void> };
  sql.end = () => Promise.resolve();
  return {
    createPgClient: vi.fn(() => sql),
    ensureSchema: vi.fn(async () => {}),
    persistMessage: vi.fn(async () => {}),
    purgeExpiredConversations: vi.fn(async () => 0),
  };
});

function createMockApi() {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  return {
    _hooks: hooks,
    id: "persist-postgres",
    name: "Persist (PostgreSQL)",
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
  } as unknown as OpenClawPluginApi & {
    _hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }>;
    logger: Record<"info" | "error", ReturnType<typeof vi.fn>>;
  };
}

beforeEach(() => {
  db.down = true;
  db.probes = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("persist-postgres — recovers after a failed init", () => {
  test("down: no persist, no connect storm; back after the window: schema once, then persists", async () => {
    vi.resetModules();
    const dbmod = await import("./db.js");
    const { default: plugin } = await import("./index.js");
    const api = createMockApi();
    plugin.register(api);
    const turn = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
    const send = () => turn({ prompt: "hello" }, { sessionKey: "s1" });
    const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

    await send();
    expect(db.probes).toBe(1);
    expect(dbmod.persistMessage).not.toHaveBeenCalled();

    advance(500);
    await send();
    advance(499);
    await send();
    expect(db.probes, "no new connect attempt inside the 1s window").toBe(1);

    db.down = false;
    advance(1);
    await send();
    expect(db.probes).toBe(2);
    expect(dbmod.ensureSchema).toHaveBeenCalledTimes(1);
    expect(dbmod.persistMessage).toHaveBeenCalledTimes(1);

    await send();
    expect(db.probes, "ready: never re-probes").toBe(2);
    expect(dbmod.persistMessage).toHaveBeenCalledTimes(2);
    const info = api.logger.info.mock.calls.flat().join("\n");
    expect(info.match(/schema ready/g)?.length).toBe(1);
  });
});
