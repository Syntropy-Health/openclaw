/**
 * R5 (openclaw-chat-readiness PVR, P0): with hardGate on, a DB failure must
 * GATE the turn (fail closed), never return {} (fail open); and a failed init
 * must RETRY with backoff instead of being cached for the life of the process.
 *
 * Every arm asserts PRESENCE of the gate (the [IDENTITY_GATE] block and the
 * safety-net append), never only the absence of a scope block — absence is
 * satisfied equally by a fix and by a crater.
 *
 * postgres is mocked at module scope with a controllable state machine so each
 * arm states exactly which DB condition it exercises.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { formatHardGateReplyAppend } from "./scope.js";

const db = vi.hoisted(() => ({
  /** Number of upcoming `SELECT 1` init probes that fail. */
  failInits: 0,
  /** When true, every non-init query fails (DB lost after init). */
  queryDown: false,
  /** Row returned by the identity lookup (null = unregistered peer). */
  identity: null as null | Record<string, unknown>,
  initProbes: 0,
  /** Identity lookups attempted (non-init queries). */
  lookups: 0,
  /** Connection-level outage: probes AND lookups fail while true. */
  down: false,
  /** Pools opened through the driver factory (must stay 1 across retries). */
  opens: 0,
}));

vi.mock("postgres", () => {
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (/SELECT 1/.test(text)) {
      db.initProbes += 1;
      if (db.down || db.failInits > 0) {
        if (db.failInits > 0) db.failInits -= 1;
        return Promise.reject(new Error('too many connections for role "openclaw_app"'));
      }
      return Promise.resolve([{ "?column?": 1 }]);
    }
    db.lookups += 1;
    if (db.down || db.queryDown)
      return Promise.reject(new Error("Connection terminated unexpectedly"));
    return Promise.resolve(db.identity ? [db.identity] : []);
  }) as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    end: () => Promise<void>;
  };
  sql.end = () => Promise.resolve();
  return {
    default: () => {
      db.opens += 1;
      return sql;
    },
  };
});

type MockApi = OpenClawPluginApi & {
  _hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }>;
};

function createMockApi(pluginConfig: Record<string, unknown>): MockApi {
  const hooks: MockApi["_hooks"] = [];
  return {
    _hooks: hooks,
    id: "auth-memory-gate",
    name: "Memory Scope Gate",
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
  } as unknown as MockApi;
}

const CHANNEL = "telegram";
const PEER = "user123";
const CTX = { sessionKey: `agent:abc:${CHANNEL}:direct:${PEER}`, messageProvider: CHANNEL };
const REGISTERED = {
  id: "u1",
  external_id: null,
  first_name: "A",
  last_name: "B",
  channel: CHANNEL,
  channel_peer_id: PEER,
  verified: false,
};

async function setup(pluginConfig: Record<string, unknown>) {
  vi.resetModules();
  const { default: plugin } = await import("./index.js");
  const api = createMockApi({ databaseUrl: "postgresql://mock/test", ...pluginConfig });
  plugin.register(api);
  const hook = (name: string) => {
    const h = api._hooks.find((x) => x.name === name);
    if (!h) throw new Error(`hook ${name} not registered`);
    return h.handler;
  };
  const turn = async () =>
    (await hook("before_agent_start")({}, CTX)) as { prependContext?: string };
  const send = async () =>
    (await hook("message_sending")({ to: PEER, content: "hi" }, { channelId: CHANNEL })) as {
      content?: string;
    };
  return { api, turn, send };
}

beforeEach(() => {
  db.failInits = 0;
  db.queryDown = false;
  db.identity = null;
  db.initProbes = 0;
  db.lookups = 0;
  db.down = false;
  db.opens = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R5 — hardGate fails CLOSED on DB error", () => {
  // Differential control: the peer is REGISTERED and the DB is down at the
  // connection level, so the ONLY route to [IDENTITY_GATE] is the fail-closed
  // catch — the ordinary "unregistered peer" branch cannot produce it.
  test("init failure (e.g. role connection limit) GATES a REGISTERED peer — not {}", async () => {
    db.identity = REGISTERED;
    db.down = true;
    const { turn } = await setup({ hardGate: true });
    const res = await turn();
    expect(res.prependContext).toContain("[IDENTITY_GATE]");
    expect(res.prependContext).toContain(`channel_peer_id: ${PEER}`);
  });

  test("the gated peer also gets the safety-net append on the outbound reply", async () => {
    db.identity = REGISTERED;
    db.down = true;
    const { turn, send } = await setup({ hardGate: true });
    await turn();
    const out = await send();
    expect(out.content).toBe("hi" + formatHardGateReplyAppend());
  });

  test("DB lost AFTER a good init (lookup query fails) also GATES the turn", async () => {
    db.identity = REGISTERED;
    const { turn } = await setup({ hardGate: true });
    expect((await turn()).prependContext).toContain("[MEMORY_SCOPE]"); // healthy baseline
    db.queryDown = true;
    expect((await turn()).prependContext).toContain("[IDENTITY_GATE]");
    expect(db.initProbes).toBe(1); // a lookup failure is not a probe storm
  });

  test("lookup failure also arms the outbound safety-net append", async () => {
    db.identity = REGISTERED;
    const { turn, send } = await setup({ hardGate: true });
    await turn();
    db.queryDown = true;
    await turn();
    expect((await send()).content).toBe("hi" + formatHardGateReplyAppend());
  });

  test("hardGate OFF: a lookup failure after a good init returns {} (soft)", async () => {
    db.identity = REGISTERED;
    const { turn } = await setup({ hardGate: false });
    await turn();
    db.queryDown = true;
    expect(await turn()).toEqual({});
  });

  test("hardGate OFF keeps the soft behaviour: DB error -> {} (no gate imposed)", async () => {
    db.failInits = 1;
    const { turn } = await setup({ hardGate: false });
    expect(await turn()).toEqual({});
  });
});

describe("R5 — a DB lost AFTER a good init also backs off (no per-turn stall)", () => {
  test("after a failed lookup, turns inside the window are gated WITHOUT touching the DB", async () => {
    db.identity = REGISTERED;
    const { turn } = await setup({ hardGate: true });
    await turn(); // healthy: probe + lookup
    db.queryDown = true;
    expect((await turn()).prependContext).toContain("[IDENTITY_GATE]"); // lookup fails
    const lookupsAfterFailure = db.lookups;
    const probesAfterFailure = db.initProbes;
    // Inside the 1s window: gated, and no new lookup or probe hits the dead DB.
    expect((await turn()).prependContext).toContain("[IDENTITY_GATE]");
    expect((await turn()).prependContext).toContain("[IDENTITY_GATE]");
    expect(db.lookups).toBe(lookupsAfterFailure);
    expect(db.initProbes).toBe(probesAfterFailure);
  });

  test("after the window, a re-probe runs; when the DB is back the gate clears", async () => {
    db.identity = REGISTERED;
    const { turn } = await setup({ hardGate: true });
    await turn();
    db.queryDown = true;
    await turn(); // fails -> backoff
    db.queryDown = false;
    vi.advanceTimersByTime(1_000);
    const back = await turn();
    expect(back.prependContext).toContain("[MEMORY_SCOPE]");
    expect(back.prependContext).not.toContain("[IDENTITY_GATE]");
  });

  test("concurrent turns share ONE in-flight probe", async () => {
    const { turn } = await setup({ hardGate: true });
    await Promise.all([turn(), turn(), turn()]);
    expect(db.initProbes).toBe(1);
  });
});

describe("R5 — a failed init RETRIES with backoff (not cached forever)", () => {
  test("recovery arm: DB comes back -> gate clears on a later turn, no restart", async () => {
    db.failInits = 1;
    db.identity = REGISTERED;
    const { turn, send } = await setup({ hardGate: true });

    expect((await turn()).prependContext).toContain("[IDENTITY_GATE]");
    vi.advanceTimersByTime(1_000); // past the first backoff window
    const recovered = await turn();
    expect(recovered.prependContext).toContain("[MEMORY_SCOPE]");
    expect(recovered.prependContext).not.toContain("[IDENTITY_GATE]");
    // and the safety net no longer appends for this peer ({} = message untouched)
    expect(await send()).toEqual({});
  });

  test("inside the backoff window no new probe is made (no probe storm), turn still gated", async () => {
    db.failInits = 5;
    const { turn } = await setup({ hardGate: true });
    await turn();
    expect(db.initProbes).toBe(1);
    await turn();
    await turn();
    expect(db.initProbes).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect((await turn()).prependContext).toContain("[IDENTITY_GATE]");
    expect(db.initProbes).toBe(2);
    expect(db.opens).toBe(1); // retries re-probe the SAME pool, never open a new one
  });

  test("backoff grows and is capped at 60s", async () => {
    db.failInits = 100;
    const { turn } = await setup({ hardGate: true });
    await turn(); // probe 1 fails -> wait 1s
    const waits = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [i, w] of waits.entries()) {
      vi.advanceTimersByTime(w - 1);
      await turn();
      expect(db.initProbes, `no probe before ${w}ms (step ${i})`).toBe(i + 1);
      vi.advanceTimersByTime(1);
      await turn();
      expect(db.initProbes, `probe at ${w}ms (step ${i})`).toBe(i + 2);
    }
  });

  test("the failure is logged with the retry delay, not 'will not retry'", async () => {
    db.failInits = 1;
    const { api, turn } = await setup({ hardGate: true });
    await turn();
    const errors = (api.logger.error as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(errors).toMatch(/init failed.*retry in 1s/);
    expect(errors).not.toContain("will not retry");
  });
});
