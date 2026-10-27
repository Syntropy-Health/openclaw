/**
 * Cross-user isolation for VERIFIED HTTP turns (peer-steering fix).
 *
 * A verified caller A (ctx.externalId = A's Clerk sub) must resolve A's row and
 * A's SJ token — NEVER a user found through a session-key-derived peer, which a
 * client can steer (e.g. a session key ending in `direct:<B's peer>`). The
 * session keys below are crafted in the raw, pre-hash form on purpose: the
 * gateway now hashes the hint, and this suite proves the identity hook does not
 * rely on that.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { queriedWith, type SqlCall } from "../../shared/identity-fixture-test-helpers.js";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  tokensUsed: [] as string[],
}));

vi.mock("postgres", async () => {
  const { makeFixtureSql: make } = await import("../../shared/identity-fixture-test-helpers.js");
  return {
    default: () => {
      const { sql, calls } = make();
      state.calls = calls;
      return sql;
    },
  };
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
vi.mock("./token-cipher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-cipher.js")>()),
  tokenCipherFromEnv: vi.fn(async () => null),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  callSyntropyTool: vi.fn(async (_base: string, token: string) => {
    state.tokensUsed.push(token);
    return { ok: false, error: "fixture" };
  }),
}));
vi.mock("./tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools.js")>()),
  createAllTools: vi.fn((_base: string, token: string) => [{ name: "fixture_tool", token }]),
}));

type ToolFactory = (ctx: Record<string, unknown>) => Array<{ token: string }> | null;

function createMockApi() {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  const factories: ToolFactory[] = [];
  const api = {
    _hooks: hooks,
    _factories: factories,
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
    registerTool: vi.fn((f: ToolFactory) => {
      factories.push(f);
    }),
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

async function boot() {
  vi.resetModules();
  const mod = await import("./index.js");
  const api = createMockApi();
  await mod.default.register(api);
  await new Promise((r) => setTimeout(r, 0));
  const hook = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
  const factory = api._factories[0];
  const fire = async (ctx: Record<string, unknown>) =>
    (await hook({ prompt: "hi" }, ctx)) as { prependContext?: string };
  return { mod, api, fire, factory, calls: () => state.calls as SqlCall[] };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.tokensUsed = [];
});

// Raw (pre-hash) steering keys: the session-derived peer is B's.
const STEER_DEVICE = "agent:main:openresponses-user:user_2A:direct:dev-B";
const STEER_WEB = "agent:main:openresponses-user:user_2A:direct:user_2B";

describe("syntropy — verified HTTP turns resolve by external_id (RED arm)", () => {
  test.each([
    ["shrinemobile", STEER_DEVICE],
    ["webchat", STEER_WEB],
  ])(
    "caller A on %s steering the session peer to B gets A's token, never B's",
    async (channel, sessionKey) => {
      const { fire, factory, calls } = await boot();
      await fire({ sessionKey, messageProvider: channel, externalId: "user_2A" });
      const tools = factory({ sessionKey, messageChannel: channel });
      expect(tools).not.toBeNull();
      expect(tools!.map((t) => t.token)).toEqual(["sj_tok_A"]);
      expect(state.tokensUsed).not.toContain("sj_tok_B");
      // The steerable peer is never even looked up for a verified turn.
      expect(queriedWith(calls(), "dev-B")).toBe(false);
      expect(queriedWith(calls(), "user_2B")).toBe(false);
      expect(queriedWith(calls(), "user_2A")).toBe(true);
    },
  );

  test("a deviceId-less verified turn with no hint also resolves A", async () => {
    const { fire, factory } = await boot();
    const sessionKey = "agent:main:openresponses-user:user_2A";
    await fire({ sessionKey, messageProvider: "shrinemobile", externalId: "user_2A" });
    expect(factory({ sessionKey, messageChannel: "shrinemobile" })!.map((t) => t.token)).toEqual([
      "sj_tok_A",
    ]);
  });

  test("a verified external_id with a row but NO token is unpaired: HTTP gate copy, no tools", async () => {
    const { fire, factory, mod } = await boot();
    const sessionKey = "agent:main:openresponses-user:user_2C:direct:dev-B";
    const res = await fire({ sessionKey, messageProvider: "shrinemobile", externalId: "user_2C" });
    expect(res.prependContext).toBe(mod.SYNTROPY_GATE_HTTP);
    expect(factory({ sessionKey, messageChannel: "shrinemobile" })).toBeNull();
  });

  test("a verified external_id with no lp_users row is unpaired", async () => {
    const { fire, factory, mod } = await boot();
    const sessionKey = "agent:main:openresponses-user:user_2nobody:direct:dev-B";
    const res = await fire({ sessionKey, messageProvider: "webchat", externalId: "user_2nobody" });
    expect(res.prependContext).toBe(mod.SYNTROPY_GATE_HTTP);
    expect(factory({ sessionKey, messageChannel: "webchat" })).toBeNull();
  });
});

describe("syntropy — tool factory fails closed on HTTP without a verified record", () => {
  test("an HTTP session with no verified record gets NO tools, even when its derived peer is cached", async () => {
    const { fire, factory } = await boot();
    // Populate the peer cache for (shrinemobile, dev-B) through the channel path.
    await fire({
      sessionKey: "agent:main:shrinemobile:direct:dev-B",
      messageProvider: "shrinemobile",
    });
    // An HTTP session whose derived peer collides with it, with no verified turn recorded.
    expect(factory({ sessionKey: STEER_DEVICE, messageChannel: "shrinemobile" })).toBeNull();
  });

  test("an HTTP session that never ran the hook gets no tools", async () => {
    const { factory } = await boot();
    expect(
      factory({ sessionKey: "agent:main:openresponses-user:user_2A", messageChannel: "webchat" }),
    ).toBeNull();
  });
});

describe("syntropy — channel turns keep the peer path (characterization)", () => {
  test("whatsapp direct:+1… resolves the linked user by (channel, peer)", async () => {
    const { fire, factory, calls } = await boot();
    const sessionKey = "agent:main:whatsapp:direct:+15550001111";
    await fire({ sessionKey, messageProvider: "whatsapp" });
    expect(factory({ sessionKey, messageChannel: "whatsapp" })!.map((t) => t.token)).toEqual([
      "sj_tok_B",
    ]);
    expect(queriedWith(calls(), "+15550001111")).toBe(true);
  });

  test("an unlinked channel peer stays unpaired with the !verify copy", async () => {
    const { fire, factory, mod } = await boot();
    const sessionKey = "agent:main:telegram:direct:nobody";
    const res = await fire({ sessionKey, messageProvider: "telegram" });
    expect(res.prependContext).toBe(mod.SYNTROPY_GATE);
    expect(factory({ sessionKey, messageChannel: "telegram" })).toBeNull();
  });
});
