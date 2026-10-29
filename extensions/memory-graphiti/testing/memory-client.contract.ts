/**
 * The memory read-surface contract (A&D §4.1, G4). One suite, run against every
 * client: the in-memory fake, and each real adapter over recorded fixtures or a
 * mocked transport (never the network). A client passes only if its behaviour
 * matches what it declares.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryCapabilityError,
  type MemoryFact,
  type MemoryFactSurface,
  type Reranker,
} from "../client.js";

export type ContractClient = MemoryFactSurface;

const ALL_RERANKERS: Reranker[] = ["rrf", "mmr", "cross_encoder"];

export type ContractHarness = {
  name: string;
  /** A fresh client plus a way to put facts into ITS store for one group. */
  make: () => { client: ContractClient; seed: (groupId: string, facts: MemoryFact[]) => void };
};

const GROUP_A = "ok_contract_group_a";
const GROUP_B = "ok_contract_group_b";

/** Deterministic fact fixture. `i` keeps ids unique and sortable. */
export function factFixture(i: number, over: Partial<MemoryFact> = {}): MemoryFact {
  const day = String((i % 28) + 1).padStart(2, "0");
  return {
    id: `e_${String(i).padStart(4, "0")}`,
    fact: `filler statement number ${i}`,
    name: "RELATES_TO",
    validAt: `2026-09-${day}T10:00:00Z`,
    invalidAt: null,
    createdAt: `2026-09-${day}T10:00:${String(i % 60).padStart(2, "0")}Z`,
    expiredAt: null,
    episodeIds: [`ep_${i}`],
    ...over,
  };
}

/** 120 valid facts plus one invalidated and one expired. */
export function seededFacts(): MemoryFact[] {
  const facts = Array.from({ length: 120 }, (_, i) => factFixture(i + 1));
  facts.push(factFixture(121, { invalidAt: "2026-10-01T00:00:00Z" }));
  facts.push(factFixture(122, { expiredAt: "2026-10-02T00:00:00Z" }));
  return facts;
}

const TOPIC = factFixture(500, {
  fact: "User sleeps badly after drinking espresso late in the evening",
});

export function runMemoryClientContract(h: ContractHarness): void {
  describe(`memory client contract: ${h.name}`, () => {
    // What the client DECLARES; every arm below holds it to that declaration.
    const caps = h.make().client.capabilities();

    describe("declared capabilities match behaviour", () => {
      it("declares rrf (the default every backend must honour)", () => {
        expect(caps.rerankers).toContain("rrf");
      });

      for (const reranker of ALL_RERANKERS) {
        const declared = caps.rerankers.includes(reranker);
        it(`${reranker}: ${declared ? "honoured (no fallback marker)" : "NOT silently honoured: every item says server_default"}`, async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, [TOPIC, factFixture(1)]);
          const r = await client.searchRanked(GROUP_A, "espresso sleep", { reranker, limit: 5 });
          expect(r.length).toBeGreaterThan(0);
          for (const item of r) {
            expect(item.rerankerApplied).toBe(declared ? undefined : "server_default");
          }
        });
      }

      it(`scores: ${caps.scores ? "every item carries a number" : "every item is null"}`, async () => {
        const { client, seed } = h.make();
        seed(GROUP_A, [TOPIC, factFixture(1, { fact: "espresso again" })]);
        const r = await client.searchRanked(GROUP_A, "espresso sleep", {
          reranker: "rrf",
          limit: 5,
        });
        expect(r.length).toBeGreaterThan(0);
        for (const item of r) {
          if (caps.scores) {
            expect(typeof item.score).toBe("number");
          } else {
            expect(item.score).toBeNull();
          }
        }
      });
    });

    if (!caps.listFacts) {
      it("listFacts (declared unsupported) throws MemoryCapabilityError backend_unsupported", async () => {
        const { client, seed } = h.make();
        seed(GROUP_A, [factFixture(1)]);
        const err = await client.listFacts(GROUP_A).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MemoryCapabilityError);
        expect((err as MemoryCapabilityError).reason).toBe("backend_unsupported");
      });
    } else {
      describe("listFacts", () => {
        it("returns every valid fact of the group exactly once, then a null cursor", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, seededFacts());
          const r = await client.listFacts(GROUP_A);
          const ids = r.facts.map((f) => f.id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBe(120);
          expect(ids).not.toContain("e_0121");
          expect(ids).not.toContain("e_0122");
          expect(r.nextCursor).toBeNull();
        });

        it("includeInvalid returns the invalidated and expired facts too", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, seededFacts());
          const r = await client.listFacts(GROUP_A, { includeInvalid: true });
          expect(r.facts.length).toBe(122);
          expect(r.facts.map((f) => f.id)).toEqual(expect.arrayContaining(["e_0121", "e_0122"]));
        });

        it("never returns another group's facts", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, [factFixture(1)]);
          seed(GROUP_B, [factFixture(2)]);
          const r = await client.listFacts(GROUP_B);
          expect(r.facts.map((f) => f.id)).toEqual(["e_0002"]);
        });

        it("limit + cursor: pages cover every fact once", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, seededFacts());
          const first = await client.listFacts(GROUP_A, { limit: 70 });
          expect(first.facts.length).toBe(70);
          expect(first.nextCursor).not.toBeNull();
          const rest = await client.listFacts(GROUP_A, { cursor: first.nextCursor ?? undefined });
          const all = [...first.facts, ...rest.facts].map((f) => f.id);
          expect(new Set(all).size).toBe(120);
          expect(rest.nextCursor).toBeNull();
        });

        it("since keeps only facts created at or after it", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, [
            factFixture(1, { createdAt: "2026-09-01T00:00:00Z" }),
            factFixture(2, { createdAt: "2026-10-01T00:00:00Z" }),
          ]);
          const r = await client.listFacts(GROUP_A, { since: "2026-09-15T00:00:00Z" });
          expect(r.facts.map((f) => f.id)).toEqual(["e_0002"]);
        });

        it("returns the MemoryFact shape", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, [factFixture(7)]);
          const [f] = (await client.listFacts(GROUP_A)).facts;
          expect(f).toEqual(factFixture(7));
        });
      });
    }

    describe("searchRanked", () => {
      it("ranks are 1..n in order, within the limit, and only the group's facts", async () => {
        const { client, seed } = h.make();
        seed(GROUP_A, [...seededFacts(), TOPIC]);
        seed(GROUP_B, [factFixture(900, { fact: "statement about espresso and sleep" })]);
        const r = await client.searchRanked(GROUP_A, "filler statement", {
          reranker: "rrf",
          limit: 10,
        });
        expect(r.length).toBeGreaterThan(0);
        expect(r.length).toBeLessThanOrEqual(10);
        expect(r.map((x) => x.rank)).toEqual(r.map((_, i) => i + 1));
        expect(r.map((x) => x.id)).not.toContain("e_0900");
      });

      it("the seeded topic is in the top 3; an unrelated query finds nothing", async () => {
        const { client, seed } = h.make();
        seed(GROUP_A, [...seededFacts(), TOPIC]);
        const hit = await client.searchRanked(GROUP_A, "espresso sleep", {
          reranker: "rrf",
          limit: 5,
        });
        expect(
          hit
            .slice(0, 3)
            .map((x) => x.id)
            .includes(TOPIC.id),
        ).toBe(true);
        const miss = await client.searchRanked(GROUP_A, "quantum zebra", {
          reranker: "rrf",
          limit: 5,
        });
        expect(miss).toEqual([]);
      });

      it("an empty group returns no results", async () => {
        const { client } = h.make();
        expect(
          await client.searchRanked(GROUP_A, "espresso", { reranker: "rrf", limit: 5 }),
        ).toEqual([]);
      });
    });

    if (!caps.forgetFacts) {
      it("forgetFacts (declared unsupported) throws MemoryCapabilityError backend_unsupported", async () => {
        const { client } = h.make();
        const err = await client.forgetFacts(GROUP_A, ["e_0001"]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MemoryCapabilityError);
      });
    } else {
      describe("forgetFacts", () => {
        it("counts deleted and absent ids; deleted facts are gone; a repeat is all absent", async () => {
          const { client, seed } = h.make();
          seed(GROUP_A, [TOPIC, factFixture(1)]);
          expect(await client.forgetFacts(GROUP_A, [TOPIC.id, "e_missing"])).toEqual({
            deleted: 1,
            absent: 1,
          });
          const after = await client.searchRanked(GROUP_A, "espresso sleep", {
            reranker: "rrf",
            limit: 5,
          });
          expect(after.map((x) => x.id)).not.toContain(TOPIC.id);
          expect(await client.forgetFacts(GROUP_A, [TOPIC.id])).toEqual({ deleted: 0, absent: 1 });
        });

        it("an empty id list is a no-op", async () => {
          const { client } = h.make();
          expect(await client.forgetFacts(GROUP_A, [])).toEqual({ deleted: 0, absent: 0 });
        });
      });
    }
  });
}
