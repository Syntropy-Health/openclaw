/**
 * The adapter confirms ingestion only by READ-BACK (A&D B; CTO #16900): submit
 * hands a batch to the store, confirm checks what the store actually holds.
 * Store-agnostic: Zep Cloud and self-hosted Graphiti both honour it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { batchText, GraphitiRestClient } from "./client.js";
import { createPgReceiptLedger, IngestNotConfirmedError } from "./receipts.js";
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
      episode: {
        get: vi.fn(edge.get ?? (async () => ({ content: batchText(ITEMS), processed: true }))),
      },
    },
  };
  Object.defineProperty(c, "zep", { value: zep });
  return { c, zep };
}

describe("Zep Cloud: submit → episode uuid; confirm → read-back", () => {
  it("submit returns the store's episode uuid as the ref", async () => {
    const { c, zep } = zepWith({});
    expect(await c.submit("oc_g", ITEMS)).toEqual({ ref: "ep-1" });
    expect(zep.graph.add).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "oc_g", data: batchText(ITEMS) }),
    );
  });

  it("submit fails as store_error when the store refuses or returns no uuid", async () => {
    const refused = zepWith({
      add: async () => {
        throw new Error("503");
      },
    });
    await expect(refused.c.submit("oc_g", ITEMS)).rejects.toMatchObject({ reason: "store_error" });
    const noUuid = zepWith({ add: async () => ({}) });
    await expect(noUuid.c.submit("oc_g", ITEMS)).rejects.toBeInstanceOf(IngestNotConfirmedError);
  });

  it("confirmed when content matches exactly AND the episode is processed", async () => {
    const { c, zep } = zepWith({});
    expect(await c.confirm("oc_g", ITEMS, { ref: "ep-1" })).toEqual({
      status: "confirmed",
      episodeIds: ["ep-1"],
    });
    expect(zep.graph.episode.get).toHaveBeenCalledWith("ep-1");
  });

  it("pending (not confirmed) while Zep is still processing", async () => {
    const { c } = zepWith({ get: async () => ({ content: batchText(ITEMS), processed: false }) });
    expect(await c.confirm("oc_g", ITEMS, { ref: "ep-1" })).toEqual({ status: "pending" });
  });

  it("pending while the episode is not visible yet (404)", async () => {
    const { c } = zepWith({
      get: async () => {
        throw Object.assign(new Error("nf"), { statusCode: 404 });
      },
    });
    expect(await c.confirm("oc_g", ITEMS, { ref: "ep-1" })).toEqual({ status: "pending" });
  });

  it("readback_mismatch when the store holds different content", async () => {
    const { c } = zepWith({ get: async () => ({ content: "something else", processed: true }) });
    await expect(c.confirm("oc_g", ITEMS, { ref: "ep-1" })).rejects.toMatchObject({
      reason: "readback_mismatch",
    });
  });

  it("store_error when the read-back itself fails (not a 404)", async () => {
    const { c } = zepWith({
      get: async () => {
        throw Object.assign(new Error("boom"), { statusCode: 500 });
      },
    });
    await expect(c.confirm("oc_g", ITEMS, { ref: "ep-1" })).rejects.toMatchObject({
      reason: "store_error",
    });
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

describe("self-hosted Graphiti: submit → batch marker; confirm → exact read-back", () => {
  const episodesFor = (marker: string, contents: string[]) =>
    contents.map((content, i) => ({
      uuid: `e${i}`,
      name: "",
      group_id: "oc_g",
      content,
      created_at: "",
      source: "message",
      source_description: marker,
    }));

  it("submit sends role-tagged messages carrying a unique marker, which is the ref", async () => {
    const c = new GraphitiRestClient("http://g");
    const add = vi.spyOn(c, "addMessages").mockResolvedValue(undefined);
    const sub = await c.submit("oc_g", ITEMS);
    expect(sub.ref).toMatch(/^openclaw:receipt:/);
    const sent = add.mock.calls[0][1];
    expect(sent.map((m) => m.source_description)).toEqual([sub.ref, sub.ref]);
    expect(sent.map((m) => m.role)).toEqual(["user", "openclaw"]);
  });

  it("confirmed once this batch's episodes hold every item exactly", async () => {
    const c = new GraphitiRestClient("http://g");
    vi.spyOn(c, "getEpisodes").mockResolvedValue(
      episodesFor("m1", ["user: I slept badly", "Sorry to hear that."]),
    );
    expect(await c.confirm("oc_g", ITEMS, { ref: "m1" })).toEqual({
      status: "confirmed",
      episodeIds: ["e0", "e1"],
    });
  });

  it("pending when only some items are held (partial read-back)", async () => {
    const c = new GraphitiRestClient("http://g");
    vi.spyOn(c, "getEpisodes").mockResolvedValue(episodesFor("m1", ["I slept badly"]));
    expect(await c.confirm("oc_g", ITEMS, { ref: "m1" })).toEqual({ status: "pending" });
  });

  it("another batch's episodes never confirm this one", async () => {
    const c = new GraphitiRestClient("http://g");
    vi.spyOn(c, "getEpisodes").mockResolvedValue(
      episodesFor("someone-else", ["I slept badly", "Sorry to hear that."]),
    );
    expect(await c.confirm("oc_g", ITEMS, { ref: "m1" })).toEqual({ status: "pending" });
  });

  it("a substring is not a match: 'ok' is not confirmed by an episode that merely contains it", async () => {
    const c = new GraphitiRestClient("http://g");
    vi.spyOn(c, "getEpisodes").mockResolvedValue(episodesFor("m1", ["okay then, see you"]));
    expect(await c.confirm("oc_g", [{ role: "user", text: "ok" }], { ref: "m1" })).toEqual({
      status: "pending",
    });
  });
});

describe("Postgres receipt ledger", () => {
  it("covered()/pending() query only this group; record() writes per entry hash, never content", async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ sql: text, values });
      if (/SELECT entry_hash FROM lp_memory_receipts/.test(text)) {
        return [{ entry_hash: "h1" }];
      }
      if (/SELECT entry_hash, ref FROM lp_memory_pending/.test(text)) {
        return [{ entry_hash: "h2", ref: "ep-9" }];
      }
      return [];
    }) as unknown as Parameters<typeof createPgReceiptLedger>[0];
    const ledger = createPgReceiptLedger(sql);
    expect([...(await ledger.covered("oc_g", ["h1", "h2"]))]).toEqual(["h1"]);
    expect(calls[0].values).toEqual(["oc_g", ["h1", "h2"]]);
    expect([...(await ledger.pending("oc_g", ["h2"]))]).toEqual([["h2", "ep-9"]]);
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
    await ledger.deleteGroup("oc_g");
    expect(calls.some((c) => /DELETE FROM lp_memory_pending WHERE group_id/.test(c.sql))).toBe(
      true,
    );
    expect(calls.some((c) => /DELETE FROM lp_memory_receipts WHERE group_id/.test(c.sql))).toBe(
      true,
    );
  });
});
