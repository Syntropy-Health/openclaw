/**
 * The PHI tripwire relaxation is EXPLICIT and CITED (CTO #16917, approvals row 42):
 * [PRINCIPAL-RULED 2026-10-26] "use Zep now, zep is accepted as BAA."
 *
 * Without `phiCloudApproval` the QA-only rail applies unchanged (tripwire.test.ts).
 * With it, the HOOK paths (capture, recall) may serve real, IDENTIFIED users;
 * anonymous turns get no memory; the graphiti_* tools stay QA-only; and what
 * leaves for the store is minimised and keyed by an opaque group id.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// The identity DB / receipt ledger: every query succeeds with no rows.
vi.mock("postgres", () => {
  const sql = Object.assign(() => Promise.resolve([]), { end: () => Promise.resolve() });
  return { default: () => sql };
});

import { graphitiConfigSchema } from "./config.js";
import { entryHash, opaqueGroupId } from "./receipts.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const APPROVAL = {
  ruling: "use Zep now, zep is accepted as BAA. productionize GCP Graphiti in parallel",
  approvalsRow: 42,
  date: "2026-10-26",
};
const REAL_WHATSAPP = { dmPolicy: "allowlist", allowFrom: ["+15551234567"] };
const CLERK = "user_2abcDEF345ghiJKL678mnoPQR";
const IDENTIFIED_CTX = {
  messageProvider: "shrinemobile",
  sessionKey: "agent:main:openresponses-user:u1",
  externalId: CLERK,
};
const ANON_CTX = {
  messageProvider: "shrinemobile",
  sessionKey: "agent:main:openresponses-user:u2",
};

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

const fakeReceipt = async (groupId: string) => ({
  store: "zep-cloud",
  groupId,
  episodeIds: ["ep-1"],
  entryHashes: [],
  contentHash: "x",
  ingestedAt: "2026-10-26T00:00:00Z",
});

afterEach(() => vi.restoreAllMocks());

describe("phiCloudApproval config (cited, complete or rejected)", () => {
  it("parses a complete approval", () => {
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
  it("an IDENTIFIED real user's turn is ingested — minimised, under an OPAQUE group id", async () => {
    const ingest = vi.spyOn(ZepCloudClient.prototype, "ingest").mockImplementation(fakeReceipt);
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
      IDENTIFIED_CTX,
    );
    await flush();
    expect(ingest).toHaveBeenCalledOnce();
    const [groupId, items] = ingest.mock.calls[0];
    expect(groupId).toBe(opaqueGroupId(CLERK));
    expect(groupId).not.toContain(CLERK);
    expect(JSON.stringify(items)).not.toContain(CLERK);
    expect(items).toEqual([
      { role: "user", text: "I slept badly" },
      { role: "assistant", text: "Sorry to hear that." },
    ]);
  });

  it("an ANONYMOUS turn is never sent (no_identity), even with the approval", async () => {
    const ingest = vi.spyOn(ZepCloudClient.prototype, "ingest").mockImplementation(fakeReceipt);
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.agent_end?.(
      { success: true, messages: [{ role: "user", content: "hello there" }] },
      ANON_CTX,
    );
    await flush();
    expect(ingest).not.toHaveBeenCalled();
  });

  it("a whole-session replay on the next turn sends only the NEW entries (receipt de-dup)", async () => {
    const ingest = vi
      .spyOn(ZepCloudClient.prototype, "ingest")
      .mockImplementation(async (g, items) => ({
        ...(await fakeReceipt(g)),
        entryHashes: items.map(entryHash),
      }));
    // In-memory ledger (no identity DB): a fixed identified userId, so de-dup is
    // observable end to end through the hook. (The pg ledger SQL is unit-tested.)
    const { hooks } = await register({
      backend: "zep-cloud",
      apiKey: "z_key",
      groupIdStrategy: "channel-sender",
      userId: "fixed-user",
      phiCloudApproval: APPROVAL,
    });
    const turn1 = [
      { role: "user", content: "I slept badly" },
      { role: "assistant", content: "Sorry to hear that." },
    ];
    await hooks.agent_end?.({ success: true, messages: turn1 }, IDENTIFIED_CTX);
    await flush();
    await hooks.agent_end?.(
      { success: true, messages: [...turn1, { role: "user", content: "and today?" }] },
      IDENTIFIED_CTX,
    );
    await flush();
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(ingest.mock.calls[1][1]).toEqual([{ role: "user", text: "and today?" }]);
  });
});

describe("recall and tools under the approval", () => {
  it("recall runs for an identified user, keyed by the opaque group", async () => {
    const search = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.before_agent_start?.({ prompt: "what do you know about me?" }, IDENTIFIED_CTX);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0][1]).toEqual([opaqueGroupId(CLERK)]);
  });

  it("recall does NOT run for an anonymous user", async () => {
    const search = vi.spyOn(ZepCloudClient.prototype, "searchFacts").mockResolvedValue([]);
    const { hooks } = await register(cloudCfg({ phiCloudApproval: APPROVAL }));
    await hooks.before_agent_start?.({ prompt: "what do you know about me?" }, ANON_CTX);
    expect(search).not.toHaveBeenCalled();
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
      await tools[name]?.("t1", params);
    }
    expect(search).not.toHaveBeenCalled();
    expect(episodes).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
