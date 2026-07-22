/**
 * Coverage for the hard-gate SAFETY-NET APPEND path (message_sending), which had
 * ZERO tests: plugin.test.ts only covered the negative early-return, and
 * integration.test.ts never touches message_sending. So the CTA could be correct
 * and still never reach a user, with every suite green.
 *
 * Lives in its own file because it mocks `postgres` at module scope — doing that
 * inside plugin.test.ts would defeat that file's deliberate DB-FAILURE tests.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";
import { formatHardGateReplyAppend } from "./scope.js";

// Tagged-template pg stub: every query resolves to [] — enough for ensureReady's
// `SELECT 1` to succeed AND for the identity lookup to return "not registered",
// which is exactly the state that arms the gate.
vi.mock("postgres", () => {
  const sql = ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve([])) as unknown as {
    (s: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    end: () => Promise<void>;
  };
  sql.end = () => Promise.resolve();
  return { default: () => sql };
});

type MockApi = OpenClawPluginApi & {
  _hooks: Array<{ name: string; handler: (...a: unknown[]) => unknown; opts: unknown }>;
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
    on: vi.fn((name: string, handler: (...a: unknown[]) => unknown, opts?: unknown) => {
      hooks.push({ name, handler, opts });
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
const SESSION_KEY = `agent:abc:${CHANNEL}:direct:${PEER}`;

describe("hard-gate safety-net append (message_sending)", () => {
  let api: MockApi;

  beforeEach(async () => {
    vi.resetModules();
    const { default: plugin } = await import("./index.js");
    api = createMockApi({ databaseUrl: "postgresql://localhost:5432/test", hardGate: true });
    plugin.register(api);
  });

  function hook(name: string) {
    const h = api._hooks.find((x) => x.name === name);
    if (!h) {
      throw new Error(`hook ${name} not registered`);
    }
    return h.handler;
  }

  /** Arms the gate: an unregistered peer takes a turn -> lands in gatedPeers. */
  async function armGate() {
    return (await hook("before_agent_start")(
      {},
      {
        sessionKey: SESSION_KEY,
        messageProvider: CHANNEL,
      },
    )) as { prependContext?: string };
  }

  test("★ a GATED peer's outgoing message gets the CTA appended (the path that had no coverage)", async () => {
    const gateResult = await armGate();
    // Sanity: the turn really was gated (else the append test proves nothing).
    expect(gateResult.prependContext).toContain("IDENTITY_GATE");

    const result = (await hook("message_sending")(
      { to: PEER, content: "Hello there" },
      { channelId: CHANNEL },
    )) as { content?: string };

    expect(result.content).toBe("Hello there" + formatHardGateReplyAppend());
    // The whole point of the gate: the user is told how to VERIFY.
    expect(result.content).toContain("/verify");
  });

  test("a DIFFERENT peer on the same channel is untouched (gate is per-peer, not per-channel)", async () => {
    await armGate();
    const result = (await hook("message_sending")(
      { to: "someone-else", content: "Hello there" },
      { channelId: CHANNEL },
    )) as { content?: string };
    expect(result).toEqual({});
  });

  test("the same peer id on a DIFFERENT channel is untouched (gate key is channel:peer)", async () => {
    await armGate();
    const result = (await hook("message_sending")(
      { to: PEER, content: "Hello there" },
      { channelId: "whatsapp" },
    )) as { content?: string };
    expect(result).toEqual({});
  });
});
