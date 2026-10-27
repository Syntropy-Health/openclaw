/**
 * Cross-user isolation for VERIFIED HTTP turns (peer-steering fix).
 *
 * On a verified turn (ctx.externalId = the caller's Clerk sub) the gate resolves
 * the caller by external_id, not by the client-steerable session/device peer.
 * Before the fix, reconcileVerifiedIdentity already refused B's row for caller A
 * (no cross-user scope), but it did so by GATING A: a verified, registered
 * caller was locked out by a peer they did not own. Now A gets A's scope, and
 * B's identifiers are never looked up. Channel turns keep the peer path.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { queriedWith, type SqlCall } from "../../shared/identity-fixture-test-helpers.js";

const state = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("postgres", async () => {
  const { makeFixtureSql } = await import("../../shared/identity-fixture-test-helpers.js");
  return {
    default: () => {
      const { sql, calls } = makeFixtureSql();
      state.calls = calls;
      return sql;
    },
  };
});

function createMockApi(pluginConfig: Record<string, unknown>) {
  const hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];
  const api = {
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
  };
  return api as unknown as OpenClawPluginApi & typeof api;
}

async function boot() {
  vi.resetModules();
  const { default: plugin } = await import("./index.js");
  const api = createMockApi({ databaseUrl: "postgresql://mock/test", hardGate: true });
  plugin.register(api);
  const hook = api._hooks.find((h) => h.name === "before_agent_start")!.handler;
  return {
    fire: async (ctx: Record<string, unknown>) =>
      (await hook({}, ctx)) as { prependContext?: string; shortCircuitReply?: string },
    calls: () => state.calls as SqlCall[],
  };
}

const isPeerLookup = (calls: SqlCall[], peer: string) =>
  calls.some(
    (c) =>
      c.text.startsWith("SELECT") &&
      c.text.includes("uc.channel_peer_id") &&
      c.values.includes(peer),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auth-memory-gate — verified turns resolve by external_id (RED arm)", () => {
  test.each([
    ["shrinemobile", "agent:main:openresponses-user:user_2A:direct:dev-B", undefined],
    ["webchat", "agent:main:openresponses-user:user_2A:direct:user_2B", undefined],
    ["shrinemobile", "agent:main:openresponses-user:user_2A", "dev-B"],
  ])(
    "caller A on %s (session %s, device %s) is scoped to A, never B",
    async (channel, sessionKey, deviceId) => {
      const { fire, calls } = await boot();
      const res = await fire({
        sessionKey,
        messageProvider: channel,
        externalId: "user_2A",
        ...(deviceId ? { deviceId } : {}),
      });
      expect(res.shortCircuitReply).toBeUndefined();
      expect(res.prependContext).toContain("[MEMORY_SCOPE]");
      expect(res.prependContext).toContain("scope_key: user_2A");
      expect(res.prependContext).not.toContain("user_2B");
      expect(isPeerLookup(calls(), "dev-B")).toBe(false);
      expect(isPeerLookup(calls(), "user_2B")).toBe(false);
      expect(queriedWith(calls(), "user_2A")).toBe(true);
    },
  );

  test("a verified external_id with no lp_users row is gated (fail closed)", async () => {
    const { fire } = await boot();
    const res = await fire({
      sessionKey: "agent:main:openresponses-user:user_2nobody:direct:dev-B",
      messageProvider: "shrinemobile",
      externalId: "user_2nobody",
    });
    expect(res.prependContext).toContain("[IDENTITY_GATE]");
    expect(res.prependContext).not.toContain("user_2B");
  });
});

describe("auth-memory-gate — channel turns keep the peer path (characterization)", () => {
  test("whatsapp direct:+1… is scoped to the linked user by (channel, peer)", async () => {
    const { fire, calls } = await boot();
    const res = await fire({
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
      messageProvider: "whatsapp",
    });
    expect(res.prependContext).toContain("scope_key: user_2B");
    expect(isPeerLookup(calls(), "+15550001111")).toBe(true);
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

describe("auth-memory-gate — an unverified HTTP-shaped session never resolves a peer (RED arm)", () => {
  test.each(LEGACY_STEERING)("%s: gated, never scoped to B", async (_name, ctx) => {
    const { fire, calls } = await boot();
    const res = await fire(ctx);
    expect(res.prependContext).toContain("[IDENTITY_GATE]");
    expect(res.prependContext).not.toContain("user_2B");
    expect(isPeerLookup(calls(), "dev-B")).toBe(false);
    expect(isPeerLookup(calls(), "user_2B")).toBe(false);
  });

  test.each(["", "   ", "\t"])(
    "a blank externalId (%j) is absent: no external_id lookup with a blank value, gated",
    async (externalId) => {
      const { fire, calls } = await boot();
      const res = await fire({
        sessionKey: "agent:main:openresponses-user:direct:dev-B",
        messageProvider: "shrinemobile",
        externalId,
      });
      expect(res.prependContext).toContain("[IDENTITY_GATE]");
      for (const c of calls()) {
        if (c.text.startsWith("SELECT") && /external_id = \$/.test(c.text)) {
          expect(String(c.values[0]).trim()).not.toBe("");
        }
      }
    },
  );
});
