/**
 * Highlights freshness wiring in the plugin (A&D §4.4, PLAN P5.1):
 *   - a capture marks the group stale ONLY when it confirmed something
 *     (read-back matched); a mismatch or an unconfirmed capture never does;
 *   - the regeneration worker starts with the service and stops on gateway_stop
 *     BEFORE the identity database closes;
 *   - no worker and no stale marks without the identity database, or while memory
 *     is refused (no pepper under the PHI approval).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "./capture.js";
import { opaqueGroupId } from "./receipts.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const order = vi.hoisted(() => [] as string[]);

vi.mock("postgres", () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("lp_user_channels")) {
        return Promise.resolve(values[1] === "u1" ? [{ external_id: CLERK_ID }] : []);
      }
      return Promise.resolve([]);
    },
    {
      end: () => {
        order.push("db.end");
        return Promise.resolve();
      },
    },
  );
  return { default: () => sql };
});

vi.mock("../../src/gateway/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/gateway/auth.js")>();
  return {
    ...actual,
    resolveClerkAuth: () => ({ issuer: "https://clerk.test" }),
    authorizeClerkJwt: async (token: string) =>
      token === "good" ? { ok: true, externalId: "user_2abcDEF345ghiJKL678mnoPQR" } : { ok: false },
  };
});

const capture = vi.hoisted(() => ({
  next: null as null | (() => Promise<CaptureResult>),
}));
vi.mock("./capture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture.js")>();
  return { ...actual, captureWithReceipts: vi.fn(() => capture.next!()) };
});

const store = vi.hoisted(() => ({ markStale: [] as string[], row: null as unknown }));
vi.mock("./highlights/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./highlights/store.js")>();
  return {
    ...actual,
    createPgHighlightStore: () => ({
      clock: async () => new Date(),
      get: async () => store.row,
      acquireLease: async () => true,
      releaseLease: async () => undefined,
      put: async () => false,
      markStale: async (g: string) => {
        store.markStale.push(g);
      },
      deleteGroup: async () => 0,
      claimOnDemand: async () => false,
      staleDue: async () => [],
      nightlyDue: async () => [],
      dropCiting: async () => 0,
    }),
  };
});

const gen = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("./highlights/generate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./highlights/generate.js")>();
  return {
    ...actual,
    generateHighlights: vi.fn(async (_facts: unknown, o: Record<string, unknown>) => {
      gen.calls.push(o);
      return { state: "empty", highlights: [], dropped: {} };
    }),
  };
});

const sched = vi.hoisted(() => ({ created: 0, started: 0, stopped: 0, opts: null as unknown }));
vi.mock("./highlights/scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./highlights/scheduler.js")>();
  return {
    ...actual,
    createHighlightScheduler: (o: unknown) => {
      sched.created++;
      sched.opts = o;
      return {
        start: () => {
          sched.started++;
        },
        stop: async () => {
          sched.stopped++;
          order.push("scheduler.stop");
        },
        tick: async () => undefined,
        requestNow: async () => false,
      };
    },
  };
});

const CLERK_ID = "user_2abcDEF345ghiJKL678mnoPQR";
const PEPPER = "a".repeat(64);
const GROUP = opaqueGroupId(CLERK_ID, PEPPER);
const APPROVAL = {
  ruling: "use Zep now, zep is accepted as BAA. productionize GCP Graphiti in parallel",
  approvalsRow: 42,
  date: "2026-10-26",
};
const TURN = {
  messageProvider: "shrinemobile",
  sessionKey: "agent:main:openresponses-user:u1",
  externalId: CLERK_ID,
  runId: "resp_1",
};
const END_EVENT = {
  success: true,
  messages: [
    { role: "user", content: [{ type: "text", text: "I slept badly" }] },
    { role: "assistant", content: [{ type: "text", text: "Noted" }] },
  ],
};

const result = (over: Partial<CaptureResult> = {}): CaptureResult => ({
  confirmed: 0,
  sent: 0,
  skipped: 0,
  dropped: 0,
  tooLong: 0,
  mismatched: 0,
  tombstoned: 0,
  ...over,
});

type Hook = (event: unknown, ctx: unknown) => unknown;
async function register(cfg: Record<string, unknown>) {
  const hooks: Record<string, Hook> = {};
  const services: Array<{ start: () => unknown; stop?: () => unknown }> = [];
  const routes: Record<string, (req: unknown, res: unknown) => Promise<void>> = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: {},
    pluginConfig: cfg,
    runtime: {},
    logger,
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(
      (r: { path: string; handler: (q: unknown, s: unknown) => Promise<void> }) => {
        routes[r.path] = r.handler;
      },
    ),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn((s: { start: () => unknown; stop?: () => unknown }) => {
      services.push(s);
    }),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => p,
    on: (name: string, h: Hook) => {
      hooks[name] = h;
    },
  };
  const mod = await import("./index.js");
  mod.default.register(api as never);
  return { hooks, services, logger, routes };
}

const CLOUD = {
  backend: "zep-cloud",
  apiKey: "z_key",
  groupIdStrategy: "identity",
  databaseUrl: "postgres://mock/db",
  phiCloudApproval: APPROVAL,
};

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

beforeEach(() => {
  process.env.OPENCLAW_MEMORY_GROUP_KEY = PEPPER;
  store.markStale.length = 0;
  order.length = 0;
  Object.assign(sched, { created: 0, started: 0, stopped: 0, opts: null });
});
afterEach(() => {
  delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
  vi.restoreAllMocks();
});

describe("highlights stale mark on capture (P5.1)", () => {
  it("a capture that confirmed entries marks the opaque group stale", async () => {
    capture.next = async () => result({ confirmed: 2, sent: 2 });
    const { hooks } = await register(CLOUD);
    await hooks.agent_end(END_EVENT, TURN);
    await flush();
    expect(store.markStale).toEqual([GROUP]);
  });

  it("RED arm: a read-back mismatch (nothing confirmed) leaves the group unmarked", async () => {
    capture.next = async () => result({ mismatched: 1, sent: 1 });
    const { hooks } = await register(CLOUD);
    await hooks.agent_end(END_EVENT, TURN);
    await flush();
    expect(store.markStale).toEqual([]);
  });

  it("a capture that fails or only sent (pending) never marks stale", async () => {
    capture.next = async () => result({ sent: 2 });
    const a = await register(CLOUD);
    await a.hooks.agent_end(END_EVENT, TURN);
    capture.next = () =>
      Promise.reject(Object.assign(new Error("mismatch"), { reason: "readback_mismatch" }));
    const b = await register(CLOUD);
    await b.hooks.agent_end(END_EVENT, TURN);
    await flush();
    expect(store.markStale).toEqual([]);
  });
});

describe("highlights worker lifecycle (P5.2 wiring)", () => {
  it("starts with the service; gateway_stop stops it BEFORE the identity DB closes", async () => {
    // Its own URL: the plugin pool is shared and ref-counted per URL across
    // registrations, so only a sole holder's end() reaches the driver.
    const { hooks, services } = await register({
      ...CLOUD,
      databaseUrl: "postgres://mock/lifecycle-only",
    });
    expect(sched.created).toBe(1);
    for (const s of services) {
      await s.start();
    }
    expect(sched.started).toBe(1);
    await hooks.gateway_stop({}, {});
    expect(order).toEqual(["scheduler.stop", "db.end"]);
  });

  it("no worker without the identity database", async () => {
    // Without a database the identity strategy (and so the approval) is not
    // available; a plain self-hosted config is the no-DB case.
    capture.next = async () => result({ confirmed: 1 });
    const { hooks } = await register({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
    });
    expect(sched.created).toBe(0);
    await hooks.agent_end(END_EVENT, TURN);
    await flush();
    expect(store.markStale).toEqual([]);
  });

  it("no worker while memory is refused (no pepper under the approval)", async () => {
    delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
    await register(CLOUD);
    expect(sched.created).toBe(0);
  });
});

describe("highlights routes registration (A&D §4.9)", () => {
  const getState = async (routes: Record<string, (q: unknown, s: unknown) => Promise<void>>) => {
    let body = "";
    await routes["/gateway/memory/highlights"](
      { method: "GET", headers: { authorization: "Bearer good" }, url: "/" },
      { writeHead: () => undefined, end: (b: string) => (body = b) },
    );
    return JSON.parse(body) as { state: string };
  };

  it("both routes are registered; under the approval with DB + pepper they are enabled", async () => {
    // No network in a unit test: the fallback listing is stubbed on the real client.
    const list = vi
      .spyOn(ZepCloudClient.prototype, "listFacts")
      .mockResolvedValue({ facts: [], nextCursor: null });
    const { routes } = await register(CLOUD);
    expect(Object.keys(routes)).toEqual(
      expect.arrayContaining(["/gateway/memory/highlights", "/gateway/memory/highlights/remove"]),
    );
    // Enabled: the stub store has no row, so a first read queues (not not_enabled).
    expect((await getState(routes)).state).toBe("unavailable");
    expect(list).toHaveBeenCalledWith(GROUP, { includeInvalid: false });
  });

  it("without the approval (self-hosted, no DB) the routes answer not_enabled", async () => {
    const { routes } = await register({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
    });
    expect((await getState(routes)).state).toBe("not_enabled");
  });

  it("DB + pepper but NO PHI approval: the store exists, the routes still answer not_enabled", async () => {
    const { routes } = await register({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "identity",
      databaseUrl: "postgres://mock/no-approval",
    });
    expect((await getState(routes)).state).toBe("not_enabled");
    // And no worker: no group's facts go to the summariser without the approval.
    expect(sched.created).toBe(0);
  });

  it("no approval: a confirmed capture never marks highlights stale", async () => {
    capture.next = async () => result({ confirmed: 3, sent: 3 });
    const { hooks } = await register({
      backend: "self-hosted",
      serverUrl: "http://localhost:8000",
      groupIdStrategy: "identity",
      databaseUrl: "postgres://mock/no-approval-2",
    });
    await hooks.agent_end(END_EVENT, TURN);
    await flush();
    expect(store.markStale).toEqual([]);
  });

  it("with memory refused (no pepper) the routes answer not_enabled", async () => {
    delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
    const { routes } = await register(CLOUD);
    expect((await getState(routes)).state).toBe("not_enabled");
  });
});

describe("configured rank constants reach generation (QG)", () => {
  it("highlights.rank from plugin config is passed to generateHighlights", async () => {
    gen.calls.length = 0;
    vi.spyOn(ZepCloudClient.prototype, "listFacts").mockResolvedValue({
      facts: [],
      nextCursor: null,
    });
    await register({ ...CLOUD, highlights: { rank: { halfLifeDays: 30 } } });
    const opts = sched.opts as { regenerate: (g: string) => Promise<unknown> };
    // The mocked store answers get() with null, so drive the real regenerate deps directly:
    // a row must exist for generation to run.
    store.row = {
      state: "unavailable",
      payload: [],
      generatedAt: new Date(),
      staleSince: null,
      sourceFactIds: [],
      epoch: "1",
    };
    await opts.regenerate(GROUP);
    store.row = null;
    expect(gen.calls.at(-1)?.rank).toMatchObject({ halfLifeDays: 30, wOcc: 0.5 });
  });
});
