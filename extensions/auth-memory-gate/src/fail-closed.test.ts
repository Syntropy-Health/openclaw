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
}));

vi.mock("postgres", () => {
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (/SELECT 1/.test(text)) {
      db.initProbes += 1;
      if (db.failInits > 0) {
        db.failInits -= 1;
        return Promise.reject(new Error('too many connections for role "openclaw_app"'));
      }
      return Promise.resolve([{ "?column?": 1 }]);
    }
    if (db.queryDown) return Promise.reject(new Error("Connection terminated unexpectedly"));
    return Promise.resolve(db.identity ? [db.identity] : []);
  }) as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    end: () => Promise<void>;
  };
  sql.end = () => Promise.resolve();
  return { default: () => sql };
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("R5 — hardGate fails CLOSED on DB error", () => {
  test("init failure (e.g. role connection limit) GATES the turn — not {}", async () => {
    db.failInits = 1;
    const { turn } = await setup({ hardGate: true });
    const res = await turn();
    expect(res.prependContext).toContain("[IDENTITY_GATE]");
    expect(res.prependContext).toContain(`channel_peer_id: ${PEER}`);
  });

  test("the gated peer also gets the safety-net append on the outbound reply", async () => {
    db.failInits = 1;
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
  });

  test("hardGate OFF keeps the soft behaviour: DB error -> {} (no gate imposed)", async () => {
    db.failInits = 1;
    const { turn } = await setup({ hardGate: false });
    expect(await turn()).toEqual({});
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
