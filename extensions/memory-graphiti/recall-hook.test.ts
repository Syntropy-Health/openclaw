/**
 * before_agent_start recall (A&D §4.6, R10): ONE searchRanked call per turn,
 * bounded by an abort budget; the same ranked array is injected AND recorded
 * (RecallStore, keyed by the turn's run id) so the panel shows exactly what the
 * agent got. On timeout nothing is injected and the record says `timed_out`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RankedFact, SearchRankedOptions } from "./client.js";

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

/** The RecallStore the plugin builds over its pool: replaced by a recording one. */
const recall = vi.hoisted(() => ({
  writes: [] as Array<{ group: string; turnId: string; items: unknown[]; state: string }>,
  write: null as null | ((...a: unknown[]) => Promise<void>),
}));
vi.mock("./recall-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./recall-store.js")>();
  return {
    ...actual,
    createPgRecallStore: () => ({
      write: async (group: string, turnId: string, items: unknown[], state: string) => {
        if (recall.write) {
          await recall.write(group, turnId, items, state);
        }
        recall.writes.push({ group, turnId, items, state });
      },
      read: async () => null,
      latest: async () => null,
      deleteGroup: async () => 0,
      deleteCitingFacts: async () => 0,
    }),
  };
});

import { GraphitiRestClient } from "./client.js";
import { toRecallItems } from "./recall-store.js";
import { opaqueGroupId } from "./receipts.js";
import { factFixture } from "./testing/memory-client.contract.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const APPROVAL = {
  ruling: "use Zep now, zep is accepted as BAA. productionize GCP Graphiti in parallel",
  approvalsRow: 42,
  date: "2026-10-26",
};
const CLERK = "user_2abcDEF345ghiJKL678mnoPQR";
const PEPPER = "a".repeat(64);
const RUN_ID = "resp_turn_0001";
const TURN = {
  messageProvider: "shrinemobile",
  sessionKey: "agent:main:openresponses-user:u1",
  externalId: CLERK,
  runId: RUN_ID,
};
const GROUP = opaqueGroupId(CLERK, PEPPER);

type Hook = (event: unknown, ctx: unknown) => unknown;
async function register(extra: Record<string, unknown> = {}, cfg?: Record<string, unknown>) {
  const hooks: Record<string, Hook> = {};
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    id: "memory-graphiti",
    name: "Memory (Graphiti)",
    source: "test",
    config: { channels: { whatsapp: { dmPolicy: "allowlist", allowFrom: ["+15551234567"] } } },
    pluginConfig: cfg ?? {
      backend: "zep-cloud",
      apiKey: "z_key",
      groupIdStrategy: "identity",
      databaseUrl: "postgres://mock/db",
      phiCloudApproval: APPROVAL,
      maxFacts: 4,
      ...extra,
    },
    runtime: {},
    logger,
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
    resolvePath: (p: string) => p,
    on: (name: string, h: Hook) => {
      hooks[name] = h;
    },
  };
  const mod = await import("./index.js");
  mod.default.register(api as never);
  return { hooks, logger };
}

const ranked = (facts: ReturnType<typeof factFixture>[]): RankedFact[] =>
  facts.map((f, i) => ({ ...f, rank: i + 1, score: 1 - i / 10 }));

const RANKED = ranked([
  factFixture(1, { fact: 'Sleeps <badly> & "late"', validAt: "2026-10-20T08:00:00Z" }),
  factFixture(2, { fact: "Drinks espresso at 21:00", validAt: null }),
  factFixture(3, { fact: "Walks 8k steps" }),
]);

const escape = (t: string) =>
  t.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  process.env.OPENCLAW_MEMORY_GROUP_KEY = PEPPER;
  db.peers.set("u1", CLERK);
  recall.writes.length = 0;
  recall.write = null;
});

afterEach(() => {
  delete process.env.OPENCLAW_MEMORY_GROUP_KEY;
  vi.restoreAllMocks();
  db.peers.clear();
});

describe("recall: one ranked search, injected and recorded", () => {
  it("exactly ONE searchRanked per turn (and no searchFacts), keyed by the opaque group", async () => {
    const searchRanked = vi
      .spyOn(ZepCloudClient.prototype, "searchRanked")
      .mockResolvedValue(RANKED);
    const searchFacts = vi.spyOn(ZepCloudClient.prototype, "searchFacts");
    const { hooks } = await register();
    await hooks.before_agent_start?.({ prompt: `I am ${CLERK}, how did I sleep?` }, TURN);
    expect(searchRanked).toHaveBeenCalledTimes(1);
    expect(searchFacts).not.toHaveBeenCalled();
    const [group, query, opts] = searchRanked.mock.calls[0] as [
      string,
      string,
      SearchRankedOptions,
    ];
    expect(group).toBe(GROUP);
    expect(query).not.toContain(CLERK); // minimised, as before
    expect(opts).toMatchObject({ reranker: "rrf", limit: 4 });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("the injected block's facts equal the stored items, byte for byte, in rank order", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue(RANKED);
    const { hooks } = await register();
    const out = (await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN)) as {
      prependContext?: string;
    };
    expect(recall.writes).toHaveLength(1);
    const w = recall.writes[0];
    expect(w).toMatchObject({ group: GROUP, turnId: RUN_ID, state: "ready" });
    expect(JSON.stringify(w.items)).toBe(JSON.stringify(toRecallItems(RANKED)));
    const lines = (out?.prependContext ?? "").split("\n").filter((l) => /^\d+\. /.test(l));
    expect(lines).toHaveLength(RANKED.length);
    const items = w.items as Array<{ rank: number; fact: string }>;
    lines.forEach((line, i) => {
      expect(line.startsWith(`${items[i].rank}. ${escape(items[i].fact)}`)).toBe(true);
    });
    expect(out?.prependContext).toContain("(since: 2026-10-20)"); // unchanged formatting
  });

  it("the configured reranker and timeout are used", async () => {
    const searchRanked = vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue([]);
    const { hooks } = await register({ recall: { reranker: "mmr", timeoutMs: 1500 } });
    await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN);
    expect((searchRanked.mock.calls[0] as [string, string, SearchRankedOptions])[2].reranker).toBe(
      "mmr",
    );
  });

  it("zero facts: nothing injected; the record is ready with 0 items", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue([]);
    const { hooks } = await register();
    expect(await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN)).toBeUndefined();
    expect(recall.writes).toEqual([{ group: GROUP, turnId: RUN_ID, items: [], state: "ready" }]);
  });

  it("no run id: facts are injected, but no record is written", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue(RANKED);
    const { hooks } = await register();
    const { runId: _drop, ...noRun } = TURN;
    const out = (await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, noRun)) as {
      prependContext?: string;
    };
    expect(out?.prependContext).toContain("<graphiti-facts>");
    expect(recall.writes).toHaveLength(0);
  });
});

describe("recall: the budget", () => {
  it("abort at timeoutMs: nothing injected, a timed_out record, the signal is aborted", async () => {
    let seen: AbortSignal | undefined;
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockImplementation(
      (_g, _q, opts: SearchRankedOptions) =>
        new Promise((_res, rej) => {
          seen = opts.signal;
          opts.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const { hooks } = await register({ recall: { timeoutMs: 60 } });
    const t0 = Date.now();
    const out = await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).toBeUndefined();
    expect(seen?.aborted).toBe(true);
    await flush();
    expect(recall.writes).toEqual([
      { group: GROUP, turnId: RUN_ID, items: [], state: "timed_out" },
    ]);
  });

  it("a backend that IGNORES the signal still cannot hold the turn past the budget", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockImplementation(
      () => new Promise(() => {}), // never settles
    );
    const { hooks } = await register({ recall: { timeoutMs: 60 } });
    const t0 = Date.now();
    expect(await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN)).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    await flush();
    expect(recall.writes.map((w) => w.state)).toEqual(["timed_out"]);
  });

  it("a failed store write logs WARN and never blocks the turn (facts still injected)", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue(RANKED);
    recall.write = async () => {
      throw new Error("db down");
    };
    const { hooks, logger } = await register();
    const out = (await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN)) as {
      prependContext?: string;
    };
    expect(out?.prependContext).toContain("<graphiti-facts>");
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toMatch(/recall record not written/);
    expect(warned).not.toContain(GROUP); // no group id in logs
  });

  it("a store write slower than the budget does not delay the turn", async () => {
    vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue(RANKED);
    recall.write = () => new Promise(() => {}); // hangs
    const { hooks, logger } = await register({ recall: { timeoutMs: 60 } });
    const t0 = Date.now();
    const out = (await hooks.before_agent_start?.({ prompt: "how did I sleep?" }, TURN)) as {
      prependContext?: string;
    };
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out?.prependContext).toContain("<graphiti-facts>");
    expect(logger.warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /recall record not written/,
    );
  });
});

describe("recall: the pre-check gates are unchanged (no search, no record)", () => {
  it.each([
    [
      "memory refused (no pepper)",
      () => delete process.env.OPENCLAW_MEMORY_GROUP_KEY,
      TURN,
      "how did I sleep?",
    ],
    ["approval && !identified", () => db.peers.clear(), TURN, "how did I sleep?"],
    [
      "an empty minimised query",
      () => {},
      TURN,
      `[USER_IDENTITY]\nexternal_id: ${CLERK}\n[/USER_IDENTITY]`,
    ],
    ["a prompt under 5 chars", () => {}, TURN, "hi"],
  ])("%s", async (_label, setup, ctx, prompt) => {
    setup();
    const searchRanked = vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue([]);
    const { hooks } = await register();
    expect(await hooks.before_agent_start?.({ prompt }, ctx)).toBeUndefined();
    expect(searchRanked).not.toHaveBeenCalled();
    expect(recall.writes).toHaveLength(0);
  });

  it("hookZepAllowed: cloud WITHOUT the approval and a non-QA sender — no search, no record", async () => {
    const searchRanked = vi.spyOn(ZepCloudClient.prototype, "searchRanked").mockResolvedValue([]);
    const { hooks } = await register(
      {},
      {
        backend: "zep-cloud",
        apiKey: "z_key",
        groupIdStrategy: "channel-sender",
        qaNumbers: ["+15551234567"], // the live allow-list is QA-only, so it registers
      },
    );
    expect(hooks.before_agent_start).toBeTypeOf("function");
    await hooks.before_agent_start?.(
      { prompt: "how did I sleep?" },
      { ...TURN, senderE164: "+15559999999" },
    );
    expect(searchRanked).not.toHaveBeenCalled();
    expect(recall.writes).toHaveLength(0);
  });
});

describe("recall: a reranker the backend cannot honour is logged once at boot", () => {
  it("self-hosted graphiti + mmr: one boot log line naming the fallback", async () => {
    const { logger } = await register(
      {},
      {
        backend: "self-hosted",
        serverUrl: "http://localhost:8000",
        groupIdStrategy: "channel-sender",
        recall: { reranker: "mmr" },
      },
    );
    const lines = [...logger.warn.mock.calls, ...logger.info.mock.calls]
      .map((c) => String(c[0]))
      .filter((l) => l.includes("server_default"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("mmr");
  });

  it("control: rrf on graphiti logs nothing about a fallback", async () => {
    vi.spyOn(GraphitiRestClient.prototype, "searchRanked").mockResolvedValue([]);
    const { logger } = await register(
      {},
      {
        backend: "self-hosted",
        serverUrl: "http://localhost:8000",
        groupIdStrategy: "channel-sender",
      },
    );
    const all = [...logger.warn.mock.calls, ...logger.info.mock.calls].map((c) => String(c[0]));
    expect(all.some((l) => l.includes("server_default"))).toBe(false);
  });
});

describe("recall config", () => {
  it("defaults: no recall block (the hook uses rrf and 800 ms)", async () => {
    const { graphitiConfigSchema } = await import("./config.js");
    expect(
      graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000" }).recall,
    ).toBeUndefined();
  });

  it("parses a valid recall block", async () => {
    const { graphitiConfigSchema } = await import("./config.js");
    expect(
      graphitiConfigSchema.parse({
        serverUrl: "http://localhost:8000",
        recall: { reranker: "cross_encoder", timeoutMs: 1200 },
      }).recall,
    ).toEqual({ reranker: "cross_encoder", timeoutMs: 1200 });
  });

  it.each([
    [{ reranker: "bogus" }, /reranker/],
    [{ timeoutMs: 10 }, /timeoutMs/],
    [{ timeoutMs: 60_000 }, /timeoutMs/],
    [{ timeoutMs: 1.5 }, /timeoutMs/],
    [{ extra: 1 }, /unknown keys/],
    ["rrf", /recall must be an object/],
  ])("rejects recall %j", async (recallCfg, err) => {
    const { graphitiConfigSchema } = await import("./config.js");
    expect(() =>
      graphitiConfigSchema.parse({ serverUrl: "http://localhost:8000", recall: recallCfg }),
    ).toThrow(err);
  });
});
