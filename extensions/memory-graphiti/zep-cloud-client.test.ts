/**
 * ZepCloudClient fact read surface (A&D §4.1) over a fake SDK object: the
 * recorded SDK shapes, never the network.
 */
import { describe, expect, it, vi } from "vitest";
import { factFixture, seededFacts } from "./testing/memory-client.contract.js";
import { attachSdk, createZepSdkFake, toSdkEdge } from "./testing/zep-sdk-fake.js";
import { ZepCloudClient } from "./zep-cloud-client.js";

const G = "ok_zep_group";

function zepClient(logger?: { warn: (m: string) => void }) {
  const fake = createZepSdkFake();
  const client = new ZepCloudClient("z_key", logger ? { logger } : undefined);
  attachSdk(client, fake.zep);
  return { client, ...fake };
}

describe("ZepCloudClient.listFacts", () => {
  it("pages 120 facts (+1 invalid, +1 expired) over 3 pages of 50 via uuidCursor", async () => {
    const { client, zep, seed } = zepClient();
    seed(G, seededFacts());
    const r = await client.listFacts(G);
    expect(r.facts.length).toBe(120);
    expect(r.nextCursor).toBeNull();
    const calls = zep.graph.edge.getByUserId.mock.calls;
    expect(calls.length).toBe(3);
    expect(calls[0]).toEqual([G, { limit: 50 }]);
    expect(calls[1]).toEqual([G, { limit: 50, uuidCursor: "e_0050" }]);
    expect(calls[2]).toEqual([G, { limit: 50, uuidCursor: "e_0100" }]);
  });

  it("drops invalidated and expired facts unless includeInvalid", async () => {
    const { client, seed } = zepClient();
    seed(G, seededFacts());
    const ids = (await client.listFacts(G)).facts.map((f) => f.id);
    expect(ids).not.toContain("e_0121");
    expect(ids).not.toContain("e_0122");
    const all = (await client.listFacts(G, { includeInvalid: true })).facts.map((f) => f.id);
    expect(all).toEqual(expect.arrayContaining(["e_0121", "e_0122"]));
    expect(all.length).toBe(122);
  });

  it("maps the SDK edge to MemoryFact (absent optional fields become null)", async () => {
    const { client, seed } = zepClient();
    const f = factFixture(3, { validAt: null, episodeIds: [] });
    seed(G, [f]);
    expect((await client.listFacts(G)).facts).toEqual([f]);
  });

  it("stops at an empty page", async () => {
    const { client, seed, zep } = zepClient();
    seed(G, seededFacts().slice(0, 100)); // exactly 2 full pages
    const r = await client.listFacts(G);
    expect(r.facts.length).toBe(100);
    expect(zep.graph.edge.getByUserId).toHaveBeenCalledTimes(3); // the 3rd is empty
    expect(r.nextCursor).toBeNull();
  });

  it("hard ceiling: stops at 2000 facts, logs truncated, and returns a cursor", async () => {
    const warn = vi.fn();
    const { client, zep } = zepClient({ warn });
    let n = 0;
    zep.graph.edge.getByUserId.mockImplementation(async (_u: string, req: { limit?: number }) =>
      Array.from({ length: req.limit ?? 50 }, () => toSdkEdge(factFixture(++n))),
    );
    const r = await client.listFacts(G);
    expect(r.facts.length).toBe(2000);
    expect(r.truncated).toBe(true);
    expect(r.nextCursor).toBe(r.facts.at(-1)?.id);
    expect(zep.graph.edge.getByUserId).toHaveBeenCalledTimes(40);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("truncated");
    expect(String(warn.mock.calls[0][0])).not.toContain(G); // no group id in logs
  });

  it("a caller limit below the ceiling is not 'truncated'", async () => {
    const warn = vi.fn();
    const { client, seed, zep } = zepClient({ warn });
    seed(G, seededFacts());
    const r = await client.listFacts(G, { limit: 70 });
    expect(r.facts.length).toBe(70);
    expect(r.truncated).toBeFalsy();
    expect(warn).not.toHaveBeenCalled();
    expect(zep.graph.edge.getByUserId.mock.calls[1][1]).toEqual({
      limit: 20,
      uuidCursor: "e_0050",
    });
  });

  it("propagates an SDK error (never an empty list that reads as 'no facts')", async () => {
    const { client, zep } = zepClient();
    zep.graph.edge.getByUserId.mockRejectedValueOnce(
      Object.assign(new Error("503"), { statusCode: 503 }),
    );
    await expect(client.listFacts(G)).rejects.toThrow("503");
  });
});
