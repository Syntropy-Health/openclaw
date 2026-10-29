/**
 * In-memory HighlightStore with the Postgres store's semantics (store.ts), for
 * tests above the store. The clock is injected so the debounce and the UTC day
 * can be driven by fake timers. The real SQL is covered by
 * highlights/store.integration.test.ts.
 */
import type { HighlightRow, HighlightStore, HighlightWrite } from "../highlights/store.js";

type Row = HighlightRow & { ondemandDay: string | null; ondemandCount: number };

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export class FakeHighlightStore implements HighlightStore {
  readonly rows = new Map<string, Row>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async clock(): Promise<Date> {
    return this.now();
  }

  async get(groupId: string): Promise<HighlightRow | null> {
    const r = this.rows.get(groupId);
    if (!r) {
      return null;
    }
    const { ondemandDay: _d, ondemandCount: _c, ...row } = r;
    return structuredClone(row);
  }

  async put(groupId: string, result: HighlightWrite, startedAt: Date): Promise<boolean> {
    const r = this.rows.get(groupId);
    if (!r) {
      return false;
    }
    r.state = result.state;
    r.payload = structuredClone(result.payload);
    r.generatedAt = this.now();
    r.sourceFactIds = [...new Set(result.payload.flatMap((h) => h.sources.map((s) => s.fact_id)))];
    if (!(r.staleSince && r.staleSince > startedAt)) {
      r.staleSince = null;
    }
    return true;
  }

  async markStale(groupId: string): Promise<void> {
    const r = this.rows.get(groupId);
    if (r) {
      r.staleSince = this.now();
    }
  }

  async deleteGroup(groupId: string): Promise<number> {
    return this.rows.delete(groupId) ? 1 : 0;
  }

  async claimOnDemand(groupId: string, cap: number): Promise<boolean> {
    const today = utcDay(this.now());
    const r = this.rows.get(groupId);
    if (!r) {
      this.rows.set(groupId, {
        state: "unavailable",
        payload: [],
        generatedAt: this.now(),
        staleSince: null,
        sourceFactIds: [],
        ondemandDay: today,
        ondemandCount: 1,
      });
      return true;
    }
    if (r.ondemandDay === today && r.ondemandCount >= cap) {
      return false;
    }
    r.ondemandCount = r.ondemandDay === today ? r.ondemandCount + 1 : 1;
    r.ondemandDay = today;
    return true;
  }

  async staleDue(opts: { debounceSec: number; cap: number; limit: number }): Promise<string[]> {
    const cutoff = this.now().getTime() - opts.debounceSec * 1000;
    const today = utcDay(this.now());
    return [...this.rows.entries()]
      .filter(
        ([, r]) =>
          r.staleSince !== null &&
          r.staleSince.getTime() <= cutoff &&
          (r.ondemandDay !== today || r.ondemandCount < opts.cap),
      )
      .toSorted(([, a], [, b]) => a.staleSince!.getTime() - b.staleSince!.getTime())
      .slice(0, opts.limit)
      .map(([g]) => g);
  }

  async dropCiting(groupId: string, factIds: string[]): Promise<number> {
    const r = this.rows.get(groupId);
    if (!r || factIds.length === 0) {
      return 0;
    }
    const gone = new Set(factIds);
    const kept = r.payload.filter((h) => !h.sources.some((s) => gone.has(s.fact_id)));
    const dropped = r.payload.length - kept.length;
    if (dropped === 0) {
      return 0;
    }
    r.payload = kept;
    r.sourceFactIds = [...new Set(kept.flatMap((h) => h.sources.map((s) => s.fact_id)))];
    if (r.state === "ready" && kept.length === 0) {
      r.state = "unavailable";
    }
    r.staleSince = this.now();
    return dropped;
  }

  async nightlyDue(limit: number): Promise<string[]> {
    return [...this.rows.entries()]
      .filter(([, r]) => r.staleSince !== null)
      .toSorted(([, a], [, b]) => a.staleSince!.getTime() - b.staleSince!.getTime())
      .slice(0, limit)
      .map(([g]) => g);
  }
}
