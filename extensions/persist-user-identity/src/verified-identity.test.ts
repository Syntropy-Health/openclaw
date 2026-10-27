/**
 * Cross-user isolation for VERIFIED HTTP turns (peer-steering fix).
 *
 * The identity block for a verified caller A (ctx.externalId = A's Clerk sub)
 * must describe A — never the user found through a client-steerable peer (a
 * session key ending in `direct:<B's peer>`, or B's device id). Channel turns
 * keep the (channel, peer) lookup.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { queriedWith, type SqlCall } from "../../shared/identity-fixture-test-helpers.js";

const state = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  const { makeFixtureSql } = await import("../../shared/identity-fixture-test-helpers.js");
  return {
    ...actual,
    createPgClient: vi.fn(() => {
      const { sql, calls } = makeFixtureSql();
      state.calls = calls;
      return sql;
    }),
    ensureUserSchema: vi.fn(async () => {}),
  };
});

vi.mock("../../syntropy/src/vault.js", () => ({
  secretNameForUser: (userId: string) => `syntropy_user_${userId}`,
  createSyntropyVault: vi.fn(() => ({ tag: "vault" })),
  vaultRpcsInstalled: vi.fn(async () => true),
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

async function boot() {
  vi.resetModules();
  const mod = await import("./index.js");
  const api = createMockApi();
  mod.default.register(api);
  const hook = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
  return {
    api,
    fire: async (ctx: Record<string, unknown>) =>
      (await hook({ prompt: "hi" }, ctx)) as { prependContext?: string },
    calls: () => state.calls as SqlCall[],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const isSelectLookup = (calls: SqlCall[], peer: string) =>
  calls.some(
    (c) =>
      c.text.startsWith("SELECT") &&
      c.text.includes("uc.channel_peer_id") &&
      c.values.includes(peer),
  );

describe("persist-user-identity — verified turns resolve by external_id (RED arm)", () => {
  test.each([
    ["shrinemobile", "agent:main:openresponses-user:user_2A:direct:dev-B", undefined],
    ["webchat", "agent:main:openresponses-user:user_2A:direct:user_2B", undefined],
    ["shrinemobile", "agent:main:openresponses-user:user_2A", "dev-B"],
  ])(
    "caller A on %s (session %s, device %s) gets A's identity, never B's",
    async (channel, sessionKey, deviceId) => {
      const { fire, calls } = await boot();
      const res = await fire({
        sessionKey,
        messageProvider: channel,
        externalId: "user_2A",
        ...(deviceId ? { deviceId } : {}),
      });
      expect(res.prependContext).toContain("user_id: uid-A");
      expect(res.prependContext).toContain("external_id: user_2A");
      expect(res.prependContext).not.toContain("uid-B");
      expect(res.prependContext).not.toContain("user_2B");
      // The steerable peer is never used as a lookup key on a verified turn.
      expect(isSelectLookup(calls(), "dev-B")).toBe(false);
      expect(isSelectLookup(calls(), "user_2B")).toBe(false);
      expect(queriedWith(calls(), "user_2A")).toBe(true);
    },
  );

  test("a verified external_id with no lp_users row gets the unknown-user block (no one else's)", async () => {
    const { fire } = await boot();
    const res = await fire({
      sessionKey: "agent:main:openresponses-user:user_2nobody:direct:dev-B",
      messageProvider: "webchat",
      externalId: "user_2nobody",
    });
    expect(res.prependContext).toContain("user_id: none");
    expect(res.prependContext).not.toContain("uid-B");
  });
});

describe("persist-user-identity — channel turns keep the peer path (characterization)", () => {
  test("whatsapp direct:+1… resolves the linked user by (channel, peer)", async () => {
    const { fire, calls } = await boot();
    const res = await fire({
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
      messageProvider: "whatsapp",
    });
    expect(res.prependContext).toContain("user_id: uid-B");
    expect(isSelectLookup(calls(), "+15550001111")).toBe(true);
  });
});

describe("persist-user-identity — [G1] auto-bind refusal is logged at WARN without ids", () => {
  test("A sending B's device id: binding refused, WARN logged, no identifier in any log", async () => {
    const { fire, api, calls } = await boot();
    const res = await fire({
      sessionKey: "agent:main:openresponses-user:user_2A",
      messageProvider: "shrinemobile",
      externalId: "user_2A",
      deviceId: "dev-B",
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      "persist-user-identity: [G1] auto-bind refused: device bound to another account",
    );
    expect(api.logger.error).not.toHaveBeenCalled();
    const logged = [api.logger.warn, api.logger.error, api.logger.info]
      .flatMap((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.flat())
      .join("\n");
    for (const id of ["dev-B", "user_2A", "user_2B", "uid-A", "uid-B"]) {
      expect(logged).not.toContain(id);
    }
    // The upsert was attempted with the ownership guard.
    expect(
      calls().some(
        (c) =>
          c.text.startsWith("INSERT INTO lp_user_channels") &&
          c.text.includes("WHERE lp_user_channels.user_id = EXCLUDED.user_id"),
      ),
    ).toBe(true);
    // The turn still proceeds with the caller's own identity.
    expect(res.prependContext).toContain("user_id: uid-A");
  });
});

const LEGACY_STEERING: Array<[string, Record<string, unknown>]> = [
  [
    "X-OpenClaw-Channel shrinemobile + body user direct:dev-B",
    { sessionKey: "agent:main:openresponses-user:direct:dev-B", messageProvider: "shrinemobile" },
  ],
  [
    "raw session key agent:main:webchat:direct:user_2B",
    { sessionKey: "agent:main:webchat:direct:user_2B", messageProvider: "webchat" },
  ],
  [
    "raw shrinemobile session key with no provider",
    { sessionKey: "agent:main:shrinemobile:direct:dev-B" },
  ],
];

describe("persist-user-identity — an unverified HTTP-shaped session never resolves a peer (RED arm)", () => {
  test.each(LEGACY_STEERING)("%s: no B identity injected", async (_name, ctx) => {
    const { fire, calls } = await boot();
    const res = await fire(ctx);
    expect(res.prependContext ?? "").not.toContain("uid-B");
    expect(res.prependContext ?? "").not.toContain("user_2B");
    expect(res.prependContext).toContain("user_id: none");
    expect(isSelectLookup(calls(), "dev-B")).toBe(false);
    expect(isSelectLookup(calls(), "user_2B")).toBe(false);
  });

  test.each(["", "   ", "\t"])(
    "a blank externalId (%j) is absent: no external_id lookup with a blank value",
    async (externalId) => {
      const { fire, calls } = await boot();
      const res = await fire({
        sessionKey: "agent:main:openresponses-user:direct:dev-B",
        messageProvider: "shrinemobile",
        externalId,
      });
      expect(res.prependContext ?? "").not.toContain("uid-B");
      for (const c of calls()) {
        if (c.text.startsWith("SELECT") && /external_id = \$/.test(c.text)) {
          expect(String(c.values[0]).trim()).not.toBe("");
        }
      }
    },
  );
});
