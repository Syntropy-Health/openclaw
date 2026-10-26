/**
 * The adapter issues a receipt ONLY after a read-back confirms the store holds
 * exactly what was sent (A&D B; CTO #16900 "receipt via read-back through the
 * adapter"). Store-agnostic: Zep Cloud and self-hosted Graphiti both honour it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchText, GraphitiRestClient } from "./client.js";
import { createPgReceiptLedger, entryHash, IngestNotConfirmedError } from "./receipts.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const ITEMS = [
  { role: "user" as const, text: "I slept badly" },
  { role: "assistant" as const, text: "Sorry to hear that." },
];

afterEach(() => vi.restoreAllMocks());

/** A ZepCloudClient whose whole SDK object is a fake: no test can reach the network. */
function zepWith(edge: {
  add?: () => Promise<unknown>;
  get?: (uuid: string) => Promise<unknown>;
  userDelete?: () => Promise<unknown>;
}) {
  const c = new ZepCloudClient("z_key");
  const zep = {
    user: {
      add: vi.fn(async () => ({})),
      delete: vi.fn(edge.userDelete ?? (async () => ({}))),
    },
    graph: {
      add: vi.fn(edge.add ?? (async () => ({ uuid: "ep-1" }))),
      episode: { get: vi.fn(edge.get ?? (async () => ({ content: batchText(ITEMS) }))) },
    },
  };
  Object.defineProperty(c, "zep", { value: zep });
  return { c, zep };
}

describe("Zep Cloud ingest → receipt by read-back", () => {
  it("receipt when the read-back content matches exactly what was sent", async () => {
    const { c, zep } = zepWith({});
    const r = await c.ingest("oc_g", ITEMS);
    expect(zep.graph.episode.get).toHaveBeenCalledWith("ep-1");
    expect(r.episodeIds).toEqual(["ep-1"]);
    expect(r.groupId).toBe("oc_g");
    expect(r.entryHashes).toEqual(ITEMS.map(entryHash));
    expect(r.store).toBe("zep-cloud");
  });

  it("NO receipt when the read-back differs (readback_mismatch)", async () => {
    const { c } = zepWith({ get: async () => ({ content: "something else" }) });
    await expect(c.ingest("oc_g", ITEMS)).rejects.toMatchObject({
      name: "IngestNotConfirmedError",
      reason: "readback_mismatch",
    });
  });

  it("NO receipt when the store call fails (store_error)", async () => {
    const { c } = zepWith({
      add: async () => {
        throw new Error("503");
      },
    });
    await expect(c.ingest("oc_g", ITEMS)).rejects.toMatchObject({ reason: "store_error" });
  });

  it("NO receipt when the store returns no episode uuid", async () => {
    const { c } = zepWith({ add: async () => ({}) });
    await expect(c.ingest("oc_g", ITEMS)).rejects.toBeInstanceOf(IngestNotConfirmedError);
  });

  it("NO receipt when the read-back itself fails", async () => {
    const { c } = zepWith({
      get: async () => {
        throw new Error("timeout");
      },
    });
    await expect(c.ingest("oc_g", ITEMS)).rejects.toMatchObject({ reason: "store_error" });
  });

  it("forget deletes the Zep user; an already-missing user counts as forgotten", async () => {
    const { c, zep } = zepWith({});
    await c.forget("oc_g");
    expect(zep.user.delete).toHaveBeenCalledWith("oc_g");
    const gone = zepWith({
      userDelete: async () => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      },
    });
    await expect(gone.c.forget("oc_g")).resolves.toBeUndefined();
    const broken = zepWith({
      userDelete: async () => {
        throw Object.assign(new Error("boom"), { statusCode: 500 });
      },
    });
    await expect(broken.c.forget("oc_g")).rejects.toThrow("boom");
  });
});

describe("self-hosted Graphiti ingest → receipt by read-back poll", () => {
  it("receipt once episodes carrying THIS batch's marker hold every item", async () => {
    const c = new GraphitiRestClient("http://g", { timeoutMs: 1000, intervalMs: 1 });
    let marker = "";
    vi.spyOn(c, "addMessages").mockImplementation(async (_g, msgs) => {
      marker = String(msgs[0]?.source_description);
    });
    let polls = 0;
    vi.spyOn(c, "getEpisodes").mockImplementation(async () => {
      polls++;
      return polls < 3
        ? []
        : ITEMS.map((m, i) => ({
            uuid: `e${i}`,
            name: "",
            group_id: "oc_g",
            content: `${m.role}: ${m.text}`,
            created_at: "",
            source: "message",
            source_description: marker,
          }));
    });
    const r = await c.ingest("oc_g", ITEMS);
    expect(marker).toMatch(/^openclaw:receipt:/);
    expect(r.episodeIds).toEqual(["e0", "e1"]);
    expect(polls).toBe(3);
  });

  it("episodes from ANOTHER batch never confirm this one", async () => {
    const c = new GraphitiRestClient("http://g", { timeoutMs: 20, intervalMs: 1 });
    vi.spyOn(c, "addMessages").mockResolvedValue(undefined);
    vi.spyOn(c, "getEpisodes").mockResolvedValue(
      ITEMS.map((m, i) => ({
        uuid: `e${i}`,
        name: "",
        group_id: "oc_g",
        content: m.text,
        created_at: "",
        source: "message",
        source_description: "openclaw:receipt:someone-else",
      })),
    );
    await expect(c.ingest("oc_g", ITEMS)).rejects.toMatchObject({ reason: "readback_timeout" });
  });

  it("a partial read-back (2 of 3 held) never yields a receipt", async () => {
    const three = [...ITEMS, { role: "user" as const, text: "third" }];
    const c = new GraphitiRestClient("http://g", { timeoutMs: 20, intervalMs: 1 });
    let marker = "";
    vi.spyOn(c, "addMessages").mockImplementation(async (_g, msgs) => {
      marker = String(msgs[0]?.source_description);
    });
    vi.spyOn(c, "getEpisodes").mockImplementation(async () =>
      ITEMS.map((m, i) => ({
        uuid: `e${i}`,
        name: "",
        group_id: "oc_g",
        content: m.text,
        created_at: "",
        source: "message",
        source_description: marker,
      })),
    );
    await expect(c.ingest("oc_g", three)).rejects.toBeInstanceOf(IngestNotConfirmedError);
  });
});

describe("Postgres receipt ledger", () => {
  it("covered() asks only for this group's hashes; record() writes one row per entry hash, never content", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return /SELECT entry_hash/.test(strings.join("?")) ? [{ entry_hash: "h1" }] : [];
    }) as unknown as Parameters<typeof createPgReceiptLedger>[0];
    const ledger = createPgReceiptLedger(sql);
    expect([...(await ledger.covered("oc_g", ["h1", "h2"]))]).toEqual(["h1"]);
    expect(calls[0].values).toEqual(["oc_g", ["h1", "h2"]]);
    await ledger.record({
      store: "zep-cloud",
      groupId: "oc_g",
      episodeIds: ["ep-1"],
      entryHashes: ["h1", "h2"],
      contentHash: "c",
      ingestedAt: "2026-10-26T00:00:00Z",
    });
    const inserts = calls.filter((c) => /INSERT INTO lp_memory_receipts/.test(c.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toMatch(/ON CONFLICT \(group_id, entry_hash\) DO NOTHING/);
    expect(JSON.stringify(inserts.map((i) => i.values))).not.toMatch(/slept|Sorry/);
  });
});
