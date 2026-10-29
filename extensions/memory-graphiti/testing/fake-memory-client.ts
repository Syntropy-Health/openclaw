/**
 * In-memory memory client for tests (A&D §4.1). It implements the fact read
 * surface with deterministic behaviour, so tests above the adapter never need a
 * store or the network:
 *   - listFacts: id order, cursor = the last id returned;
 *   - searchRanked: token overlap with the query (facts with none are not hits),
 *     then the newest first, then id;
 *   - forgetFacts: deletes within the group only.
 * It runs the same contract suite as the real adapters.
 */
import type {
  ListFactsOptions,
  ListFactsResult,
  MemoryFact,
  MemoryFactSurface,
  RankedFact,
  SearchRankedOptions,
} from "../client.js";

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);

const isValid = (f: MemoryFact) => !f.invalidAt && !f.expiredAt;

export class FakeMemoryClient implements MemoryFactSurface {
  readonly label = "fake-memory";
  private readonly groups = new Map<string, Map<string, MemoryFact>>();

  /** Put facts into a group (test setup). */
  seed(groupId: string, facts: MemoryFact[]): void {
    const g = this.groups.get(groupId) ?? new Map<string, MemoryFact>();
    for (const f of facts) {
      g.set(f.id, structuredClone(f));
    }
    this.groups.set(groupId, g);
  }

  private factsOf(groupId: string): MemoryFact[] {
    return [...(this.groups.get(groupId)?.values() ?? [])].toSorted((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  async listFacts(groupId: string, opts: ListFactsOptions = {}): Promise<ListFactsResult> {
    const since = opts.since ? Date.parse(opts.since) : null;
    const after = this.factsOf(groupId).filter((f) => !opts.cursor || f.id > opts.cursor);
    const facts: MemoryFact[] = [];
    let lastRead: string | null = null;
    for (const f of after) {
      if (opts.limit !== undefined && facts.length >= opts.limit) {
        return { facts, nextCursor: lastRead };
      }
      lastRead = f.id;
      if (!opts.includeInvalid && !isValid(f)) {
        continue;
      }
      if (since !== null && Date.parse(f.createdAt) < since) {
        continue;
      }
      facts.push(structuredClone(f));
    }
    return { facts, nextCursor: null };
  }

  async searchRanked(
    groupId: string,
    query: string,
    opts: SearchRankedOptions,
  ): Promise<RankedFact[]> {
    opts.signal?.throwIfAborted();
    const q = tokens(query);
    const scored = this.factsOf(groupId)
      .filter(isValid)
      .map((f) => {
        const t = tokens(f.fact);
        const overlap = [...q].filter((x) => t.has(x)).length;
        return { f, overlap };
      })
      .filter((x) => x.overlap > 0)
      .toSorted(
        (a, b) =>
          b.overlap - a.overlap ||
          Date.parse(b.f.createdAt) - Date.parse(a.f.createdAt) ||
          (a.f.id < b.f.id ? -1 : 1),
      )
      .slice(0, Math.max(0, opts.limit));
    return scored.map(({ f, overlap }, i) => ({
      ...structuredClone(f),
      rank: i + 1,
      score: q.size > 0 ? overlap / q.size : 0,
    }));
  }

  async forgetFacts(
    groupId: string,
    factIds: string[],
  ): Promise<{ deleted: number; absent: number }> {
    const g = this.groups.get(groupId);
    let deleted = 0;
    let absent = 0;
    for (const id of new Set(factIds)) {
      if (g?.delete(id)) {
        deleted++;
      } else {
        absent++;
      }
    }
    return { deleted, absent };
  }
}
