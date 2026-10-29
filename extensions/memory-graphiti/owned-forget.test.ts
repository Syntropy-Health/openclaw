/**
 * P2.9b: a fact is deleted only when it belongs to the caller's group.
 *
 * Zep edge ids are global and `graph.edge.delete` takes no user, so the backend
 * cannot refuse a foreign id. The ownership check therefore lives here, and the
 * guard below keeps every other module from calling `forgetFacts` directly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryCapabilityError,
  type ListFactsOptions,
  type ListFactsResult,
  type MemoryCapabilities,
  type MemoryFact,
  type MemoryFactSurface,
  type RankedFact,
} from "./client.js";
import { forgetOwnedFacts } from "./owned-forget.js";

const fact = (id: string, extra: Partial<MemoryFact> = {}): MemoryFact => ({
  id,
  fact: `fact ${id}`,
  name: "RELATES_TO",
  validAt: null,
  invalidAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  expiredAt: null,
  episodeIds: [],
  ...extra,
});

/**
 * Behaves like Zep: listing is per group, but delete-by-id is GLOBAL, so a
 * foreign id passed to forgetFacts really is deleted. Pages are `pageSize` long.
 */
class GlobalDeleteBackend implements MemoryFactSurface {
  readonly byGroup = new Map<string, MemoryFact[]>();
  readonly forgetCalls: string[][] = [];
  constructor(private readonly pageSize = 2) {}

  seed(group: string, facts: MemoryFact[]): void {
    this.byGroup.set(group, [...(this.byGroup.get(group) ?? []), ...facts]);
  }

  has(id: string): boolean {
    return [...this.byGroup.values()].some((fs) => fs.some((f) => f.id === id));
  }

  capabilities(): MemoryCapabilities {
    return { listFacts: true, forgetFacts: true, rerankers: ["rrf"], scores: false };
  }

  async listFacts(groupId: string, opts: ListFactsOptions = {}): Promise<ListFactsResult> {
    const all = (this.byGroup.get(groupId) ?? []).filter(
      (f) => opts.includeInvalid || (!f.invalidAt && !f.expiredAt),
    );
    const start = opts.cursor ? all.findIndex((f) => f.id === opts.cursor) + 1 : 0;
    const page = all.slice(start, start + this.pageSize);
    const more = start + this.pageSize < all.length;
    return { facts: page, nextCursor: more ? page[page.length - 1].id : null };
  }

  async searchRanked(): Promise<RankedFact[]> {
    return [];
  }

  async forgetFacts(_groupId: string, ids: string[]): Promise<{ deleted: number; absent: number }> {
    this.forgetCalls.push([...ids]);
    let deleted = 0;
    let absent = 0;
    for (const id of new Set(ids)) {
      let hit = false;
      for (const [g, fs] of this.byGroup) {
        const next = fs.filter((f) => f.id !== id);
        hit ||= next.length !== fs.length;
        this.byGroup.set(g, next);
      }
      if (hit) {
        deleted++;
      } else {
        absent++;
      }
    }
    return { deleted, absent };
  }
}

describe("forgetOwnedFacts", () => {
  it("RED arm: a fact id belonging to another group is never deleted", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_A", [fact("a1")]);
    b.seed("ok_B", [fact("b1")]);

    const out = await forgetOwnedFacts(b, "ok_A", ["a1", "b1"]);

    expect(out).toEqual({ deleted: 1, absent: 0, notOwned: 1 });
    expect(b.has("b1")).toBe(true);
    expect(b.has("a1")).toBe(false);
    // The backend never even saw the foreign id.
    expect(b.forgetCalls.flat()).not.toContain("b1");
  });

  it("only foreign ids: the backend delete is not called at all", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_A", [fact("a1")]);
    b.seed("ok_B", [fact("b1"), fact("b2")]);

    expect(await forgetOwnedFacts(b, "ok_A", ["b1", "b2"])).toEqual({
      deleted: 0,
      absent: 0,
      notOwned: 2,
    });
    expect(b.forgetCalls).toEqual([]);
    expect(b.has("b1") && b.has("b2")).toBe(true);
  });

  it("finds owned ids on later pages, and owned invalidated facts can be removed", async () => {
    const b = new GlobalDeleteBackend(2);
    b.seed("ok_A", [
      fact("a1"),
      fact("a2"),
      fact("a3"),
      fact("a4", { invalidAt: "2026-10-02T00:00:00Z" }),
      fact("a5"),
    ]);

    expect(await forgetOwnedFacts(b, "ok_A", ["a5", "a4"])).toEqual({
      deleted: 2,
      absent: 0,
      notOwned: 0,
    });
    expect(b.has("a5") || b.has("a4")).toBe(false);
    expect(b.has("a1")).toBe(true);
  });

  it("an id that is in no group counts as not owned; duplicates count once; empty is a no-op", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_A", [fact("a1")]);

    expect(await forgetOwnedFacts(b, "ok_A", ["a1", "a1", "gone"])).toEqual({
      deleted: 1,
      absent: 0,
      notOwned: 1,
    });
    expect(await forgetOwnedFacts(b, "ok_A", [])).toEqual({ deleted: 0, absent: 0, notOwned: 0 });
  });

  it("stops listing once every requested id is found", async () => {
    const b = new GlobalDeleteBackend(1);
    b.seed("ok_A", [fact("a1"), fact("a2"), fact("a3"), fact("a4")]);
    const list = vi.spyOn(b, "listFacts");

    await forgetOwnedFacts(b, "ok_A", ["a1"]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][1]).toMatchObject({ includeInvalid: true });
  });

  it("a backend that cannot list facts refuses with the typed error and deletes nothing", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_B", [fact("b1")]);
    b.listFacts = async () => {
      throw new MemoryCapabilityError("backend_unsupported");
    };

    await expect(forgetOwnedFacts(b, "ok_A", ["b1"])).rejects.toBeInstanceOf(MemoryCapabilityError);
    expect(b.forgetCalls).toEqual([]);
  });

  it("a listing that never terminates is cut off and deletes nothing", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_B", [fact("b1")]);
    b.listFacts = async () => ({ facts: [fact("loop")], nextCursor: "loop" });

    await expect(forgetOwnedFacts(b, "ok_A", ["b1"])).rejects.toThrow(/did not finish/);
    expect(b.forgetCalls).toEqual([]);
  });
});

describe("forgetOwnedFacts beforeDelete", () => {
  it("receives the owned facts (with episodes) before anything is deleted", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_A", [fact("a1", { episodeIds: ["ep1"] }), fact("a2")]);
    b.seed("ok_B", [fact("b1")]);
    const seen: Array<{ ids: string[]; stillThere: boolean }> = [];
    await forgetOwnedFacts(b, "ok_A", ["a1", "b1"], {
      beforeDelete: async (owned) => {
        seen.push({ ids: owned.map((f) => f.id), stillThere: b.has("a1") });
        expect(owned[0].episodeIds).toEqual(["ep1"]);
      },
    });
    expect(seen).toEqual([{ ids: ["a1"], stillThere: true }]);
    expect(b.has("a1")).toBe(false);
  });

  it("a failing beforeDelete deletes nothing and propagates", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_A", [fact("a1")]);
    await expect(
      forgetOwnedFacts(b, "ok_A", ["a1"], {
        beforeDelete: async () => {
          throw new Error("tombstone write failed");
        },
      }),
    ).rejects.toThrow(/tombstone/);
    expect(b.has("a1")).toBe(true);
    expect(b.forgetCalls).toEqual([]);
  });

  it("not called when nothing is owned", async () => {
    const b = new GlobalDeleteBackend();
    b.seed("ok_B", [fact("b1")]);
    let called = false;
    await forgetOwnedFacts(b, "ok_A", ["b1"], {
      beforeDelete: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});

/** A relative path in POSIX form, whatever the platform separator. */
const toPosixPath = (rel: string): string => rel.split(path.sep).join("/");

/** Non-test source files under `root` that call `.forgetFacts(` (POSIX relative paths). */
function filesCallingForgetFacts(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        /\.(c|m)?(t|j)sx?$/.test(entry.name) &&
        !/\.test\.|\.contract\.|^fake-|-fake\./.test(entry.name) &&
        /\bforgetFacts\b/.test(fs.readFileSync(full, "utf8"))
      ) {
        hits.push(toPosixPath(path.relative(root, full)));
      }
    }
  };
  walk(root);
  return hits.toSorted();
}

describe("P2.9b guard: forgetFacts is called only through forgetOwnedFacts", () => {
  it("no other plugin module calls .forgetFacts( directly", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    // Any mention of the identifier (call, bracket access, destructuring) outside
    // the interface, the backend definitions and the one sanctioned caller.
    expect(filesCallingForgetFacts(root)).toEqual([
      "client.ts",
      "owned-forget.ts",
      "zep-cloud-client.ts",
    ]);
  });
});
