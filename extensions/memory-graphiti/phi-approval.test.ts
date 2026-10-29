/**
 * The PHI tripwire relaxation is EXPLICIT and CITED (CTO #16917, approvals row 42):
 * [PRINCIPAL-RULED 2026-10-26] "use Zep now, zep is accepted as BAA."
 *
 * Without `phiCloudApproval` the QA-only rail applies unchanged (tripwire.test.ts).
 * With it, the HOOK paths (capture, recall) may serve real users — but only a
 * VERIFIED identity the auth gate would also accept (same peer derivation,
 * external_id present, reconciled with the turn's Clerk sub). Everyone else
 * gets no memory, the graphiti_* tools stay QA-only, and what leaves for the
 * store is minimised and keyed by an opaque group id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Identity DB: peer → lp_users.external_id (null = registered but unverified).
const db = vi.hoisted(() => ({ peers: new Map<string, string | null>() }));
vi.mock("postgres", () => {
  const sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("lp_user_channels")) {
        const peer = values[1] as string;
        return Promise.resolve(db.peers.has(peer) ? [{ external_id: db.peers.get(peer) }] : []);
      }
      return Promise.resolve([]);
    },
    { end: () => Promise.resolve() },
  );
  return { default: () => sql };
});

import { graphitiConfigSchema } from "./config.js";
import { opaqueGroupId } from "./receipts.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const APPROVAL = {
  ruling: "use Zep now, zep is accepted as BAA. productionize GCP Graphiti in parallel",
  approvalsRow: 42,
  date: "2026-10-26",
};
const REAL_WHATSAPP = { dmPolicy: "allowlist", allowFrom: ["+15551234567"] };
const CLERK = "user_2abcDEF345ghiJKL678mnoPQR";
const ctxFor = (peer: string, externalId?: string) => ({
  messageProvider: "shrinemobile",
  sessionKey: `agent:main:openresponses-user:${peer}`,
  ...(externalId ? { externalId } : {}),
});
const VERIFIED = ctxFor("u1", CLERK);
/** A valid group-id pepper (32 random bytes as hex in production). */
const PEPPER = "a".repeat(64);

const flush = () => new Promise((r) => setTimeout(r, 0));

type Hook = (event: unknown, ctx: unknown) => unknown;
async function register(pluginConfig: Record<string, unknown>) {
  const hooks: Record<string, Hook> = {};
  const tools: Record<string, (id: string, p: unknown) => unknown> = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: { channels: { whatsapp: REAL_WHATSAPP } },
    pluginConfig,
    runtime: {},
    logger,
    registerTool: vi.fn(
      (tool: { name?: string; execute?: (id: string, p: unknown) => unknown }) => {
        if (tool?.name && tool.execute) {
          tools[tool.name] = tool.execute;
        }
      },
    ),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => p,
    on: (name: string, h: Hook) => {
      hooks[name] = h;
    },
  };
  const mod = await import("./index.js");
  await mod.default.register(api as never);
  return { hooks, tools, logger };
}

const cloudCfg = (extra: Record<string, unknown> = {}) => ({
  backend: "zep-cloud",
  apiKey: "z_key",
  groupIdStrategy: "identity",
  databaseUrl: "postgres://mock/db",
  ...extra,
});

/** Stub the store edge; return the submit spy ("not called" = nothing sent). */
function spyStore() {
  vi.spyOn(ZepCloudClient.prototype, "confirm").mockResolvedValue({
    status: "confirmed",
    episodeIds: ["ep-1"],
  });
  return vi.spyOn(ZepCloudClient.prototype, "submit").mockResolvedValue({ ref: "ep-1" });
}

beforeEach(() => {
  process.env.OPENCLAW_MEMORY_GROUP_KEY = PEPPER;
});

afterEach(() => {
  delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
  vi.restoreAllMocks();
  db.peers.clear();
  delete process.env.GETZEP_API_KEY;
});

describe("phiCloudApproval config (cited, complete, per-user — or rejected)", () => {
  it("parses a complete approval with the identity strategy", () => {
    expect(
      graphitiConfigSchema.parse(cloudCfg({ phiCloudApproval: APPROVAL })).phiCloudApproval,
    ).toEqual(APPROVAL);
  });
  it.each([
    [{ ...APPROVAL, ruling: "ok" }, /ruling/],
    [{ ...APPROVAL, approvalsRow: 0 }, /approvalsRow/],
    [{ ...APPROVAL, date: "26 Oct" }, /date/],
    [{ ruling: APPROVAL.ruling, date: APPROVAL.date }, /approvalsRow/],
    [{ ...APPROVAL, extra: 1 }, /unknown keys/],
  ])("rejects a half-written approval %#", (a, err) => {
    expect(() => graphitiConfigSchema.parse(cloudCfg({ phiCloudApproval: a }))).toThrow(err);
  });
  it("rejects the approval with a fixed userId (would pool every user into one memory)", () => {
    expect(() =>
      graphitiConfigSchema.parse(cloudCfg({ phiCloudApproval: APPROVAL, userId: "fixed" })),
    ).toThrow(/per-user memory/);
  });
  it("rejects the approval with a non-identity strategy", () => {
    expect(() =>
      graphitiConfigSchema.parse(
        cloudCfg({ phiCloudApproval: APPROVAL, groupIdStrategy: "channel-sender" }),
      ),
    ).toThrow(/per-user memory/);
  });
  it("zep-cloud without apiKey reads GETZEP_API_KEY from the env (no ${...} in shared config)", () => {
    process.env.GETZEP_API_KEY = "z_from_env";
    const { apiKey: _omit, ...noKey } = cloudCfg();
    expect(graphitiConfigSchema.parse(noKey).apiKey).toBe("z_from_env");
  });
  it("zep-cloud with neither apiKey nor env fails THIS plugin, naming only the variable", () => {
    const { apiKey: _omit, ...noKey } = cloudCfg();
    expect(() => graphitiConfigSchema.parse(noKey)).toThrow(/GETZEP_API_KEY/);
  });
});

describe("registration with the approval", () => {
  it("control: cloud WITHOUT approval and a real allow-list still refuses to register", async () => {
    await expect(register(cloudCfg())).rejects.toThrow(/phi_tripwire/);
  });

  it("cloud WITH approval registers and logs the approval loudly (row + date)", async () => {
    const { logger } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toMatch(/PHI cloud approval in force/);
    expect(warned).toMatch(/approvals row 42/);
    expect(warned).toMatch(/2026-10-26/);
  });
});

describe("capture under the approval", () => {
  it("a VERIFIED user's turn is sent — minimised, under an OPAQUE group id", async () => {
    db.peers.set("u1", CLERK);
    const submit = spyStore();
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.agent_end?.(
      {
        success: true,
        messages: [
          {
            role: "user",
            content: `[USER_IDENTITY]\nexternal_id: ${CLERK}\n[/USER_IDENTITY]\n\nI slept badly`,
          },
          { role: "assistant", content: "Sorry to hear that." },
        ],
      },
      VERIFIED,
    );
    await flush();
    expect(submit).toHaveBeenCalledOnce();
    const [groupId, items] = submit.mock.calls[0];
    expect(groupId).toBe(opaqueGroupId(CLERK, PEPPER));
    expect(JSON.stringify([groupId, items])).not.toContain(CLERK);
    expect(items).toEqual([
      { role: "user", text: "I slept badly" },
      { role: "assistant", text: "Sorry to hear that." },
    ]);
  });

  it.each([
    ["anonymous (no identity row)", () => {}, ctxFor("u2")],
    [
      "a turn the gate blocks: verified Clerk sub but no bound identity row",
      () => {},
      ctxFor("u3", CLERK),
    ],
    [
      "a Clerk sub that does not match the row (reconcile)",
      () => db.peers.set("u4", "user_someoneElse0000000000000"),
      ctxFor("u4", CLERK),
    ],
    [
      "a registered but UNVERIFIED peer (no external_id)",
      () => db.peers.set("u5", null),
      ctxFor("u5"),
    ],
  ])("%s: nothing is sent and nothing is recalled", async (_label, setup, ctx) => {
    setup();
    const submit = spyStore();
    const search = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.before_agent_start?.({ prompt: "what do you know about me?" }, ctx);
    await hooks.agent_end?.(
      { success: true, messages: [{ role: "user", content: "hello there" }] },
      ctx,
    );
    await flush();
    expect(search).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("the group-id pepper is REQUIRED under the approval (CTO #16929)", () => {
  it.each([
    ["missing", undefined],
    ["too short", "short-pepper"],
  ])("pepper %s: capture and recall REFUSE, loudly", async (_label, value) => {
    if (value === undefined) {
      delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
    } else {
      process.env.OPENCLAW_MEMORY_GROUP_KEY = value;
    }
    db.peers.set("u1", CLERK);
    const submit = spyStore();
    const search = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const { hooks, logger } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.before_agent_start?.({ prompt: "what do you know about me?" }, VERIFIED);
    await hooks.agent_end?.(
      { success: true, messages: [{ role: "user", content: "I slept badly" }] },
      VERIFIED,
    );
    await flush();
    expect(search).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /OPENCLAW_MEMORY_GROUP_KEY.*REFUSED/,
    );
  });

  it("the keyed group id is what reaches the store (not the unkeyed hash)", async () => {
    db.peers.set("u1", CLERK);
    const submit = spyStore();
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.agent_end?.(
      { success: true, messages: [{ role: "user", content: "I slept badly" }] },
      VERIFIED,
    );
    await flush();
    expect(submit.mock.calls[0][0]).toMatch(/^ok_/);
    expect(submit.mock.calls[0][0]).not.toBe(opaqueGroupId(CLERK));
  });
});

describe("recall and tools under the approval", () => {
  it("recall runs for a verified user, keyed by the opaque group, with a minimised query", async () => {
    db.peers.set("u1", CLERK);
    const search = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.before_agent_start?.({ prompt: `my id is ${CLERK}, what do you know?` }, VERIFIED);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][1]).toEqual([opaqueGroupId(CLERK, PEPPER)]);
    expect(search.mock.calls[0][0]).not.toContain(CLERK);
  });

  it("the graphiti_* tools stay QA-only: no per-call identity, so no cross-user read", async () => {
    const search = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const episodes = vi.spyOn(ZepCloudClient.prototype, "getEpisodes").mockResolvedValue([]);
    const add = vi.spyOn(ZepCloudClient.prototype, "addMessages").mockResolvedValue(undefined);
    const { tools } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    for (const [name, params] of [
      ["memory_search", { query: "anything" }],
      ["memory_recall", {}],
      ["memory_store", { text: "remember this" }],
    ] as const) {
      expect(tools[name], `${name} must be registered`).toBeTypeOf("function");
      await tools[name]("t1", params);
    }
    expect(search).not.toHaveBeenCalled();
    expect(episodes).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
