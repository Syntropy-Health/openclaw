import type { Highlight, HighlightCacheState } from "./types.js";

type Sql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export type HighlightRow = {
  state: HighlightCacheState;
  payload: Highlight[];
  generatedAt: Date;
  staleSince: Date | null;
  sourceFactIds: string[];
};

export type HighlightWrite = {
  state: HighlightCacheState;
  payload: Highlight[];
};

/** The per-group highlight cache (A&D §5): lp_memory_highlights. */
export interface HighlightStore {
  /** The database clock. Generation start times must come from here. */
  clock(): Promise<Date>;
  get(groupId: string): Promise<HighlightRow | null>;
  /**
   * Store a generation result into the group's EXISTING row; returns whether one
   * was updated. It never creates a row (claimOnDemand does), so a forget that
   * deleted the row first stays total, on any instance. `startedAt` is
   * store.clock() read when the run began: a stale mark made after it survives
   * (that turn is not reflected yet); an older mark is cleared.
   */
  put(groupId: string, result: HighlightWrite, startedAt: Date): Promise<boolean>;
  /** Mark an existing row stale (now). A group with no row is left alone. */
  markStale(groupId: string): Promise<void>;
  /** Delete the group's row (forget). Returns rows removed. */
  deleteGroup(groupId: string): Promise<number>;
  /**
   * Take one of today's (UTC, database clock) on-demand generation slots. A group
   * with no row gets an `unavailable` placeholder holding slot 1. False when the
   * cap is reached; atomic under concurrency.
   */
  claimOnDemand(groupId: string, cap: number): Promise<boolean>;
  /** Groups stale for at least `debounceSec` and still under today's cap. */
  staleDue(opts: { debounceSec: number; cap: number; limit: number }): Promise<string[]>;
  /** Every stale group, whatever its on-demand count (the nightly run). */
  nightlyDue(limit: number): Promise<string[]>;
}

type Row = {
  state: string;
  payload: unknown;
  generated_at: Date | string;
  stale_since: Date | string | null;
  source_fact_ids: string[];
};

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export function createPgHighlightStore(sql: Sql): HighlightStore {
  return {
    async clock() {
      const rows = await sql<{ now: Date | string }>`SELECT now() AS now`;
      return toDate(rows[0].now);
    },

    async get(groupId) {
      const rows = await sql<Row>`
        SELECT state, payload, generated_at, stale_since, source_fact_ids
        FROM lp_memory_highlights WHERE group_id = ${groupId}`;
      const r = rows[0];
      if (!r) {
        return null;
      }
      return {
        state: r.state as HighlightCacheState,
        payload: r.payload as Highlight[],
        generatedAt: toDate(r.generated_at),
        staleSince: r.stale_since === null ? null : toDate(r.stale_since),
        sourceFactIds: r.source_fact_ids,
      };
    },

    async put(groupId, result, startedAt) {
      const ids = [...new Set(result.payload.flatMap((h) => h.sources.map((src) => src.fact_id)))];
      // Payload sent as TEXT for Postgres to parse: a bare `${string}::jsonb`
      // would be JSON-encoded again by the driver and stored as a JSON string.
      const payload = JSON.stringify(result.payload);
      const rows = await sql<{ group_id: string }>`
        UPDATE lp_memory_highlights SET
          payload = ${payload}::text::jsonb,
          state = ${result.state},
          generated_at = now(),
          source_fact_ids = ${ids}::text[],
          stale_since = CASE WHEN stale_since > ${startedAt} THEN stale_since ELSE NULL END
        WHERE group_id = ${groupId}
        RETURNING group_id`;
      return rows.length === 1;
    },

    async markStale(groupId) {
      await sql`UPDATE lp_memory_highlights SET stale_since = now() WHERE group_id = ${groupId}`;
    },

    async claimOnDemand(groupId, cap) {
      const rows = await sql<{ n: number }>`
        INSERT INTO lp_memory_highlights
          (group_id, payload, state, generated_at, source_fact_ids, ondemand_day, ondemand_count)
        VALUES (${groupId}, '[]'::jsonb, 'unavailable', now(), '{}'::text[],
                (now() AT TIME ZONE 'utc')::date, 1)
        ON CONFLICT (group_id) DO UPDATE SET
          ondemand_count = CASE
            WHEN lp_memory_highlights.ondemand_day = (now() AT TIME ZONE 'utc')::date
            THEN lp_memory_highlights.ondemand_count + 1
            ELSE 1
          END,
          ondemand_day = (now() AT TIME ZONE 'utc')::date
        WHERE lp_memory_highlights.ondemand_day IS DISTINCT FROM (now() AT TIME ZONE 'utc')::date
           OR lp_memory_highlights.ondemand_count < ${cap}
        RETURNING ondemand_count AS n`;
      return rows.length === 1;
    },

    async staleDue({ debounceSec, cap, limit }) {
      const rows = await sql<{ group_id: string }>`
        SELECT group_id FROM lp_memory_highlights
        WHERE stale_since <= now() - make_interval(secs => ${debounceSec})
          AND (ondemand_day IS DISTINCT FROM (now() AT TIME ZONE 'utc')::date
               OR ondemand_count < ${cap})
        ORDER BY stale_since LIMIT ${limit}`;
      return rows.map((r) => r.group_id);
    },

    async nightlyDue(limit) {
      const rows = await sql<{ group_id: string }>`
        SELECT group_id FROM lp_memory_highlights
        WHERE stale_since IS NOT NULL ORDER BY stale_since LIMIT ${limit}`;
      return rows.map((r) => r.group_id);
    },

    async deleteGroup(groupId) {
      const rows = await sql<{ group_id: string }>`
        DELETE FROM lp_memory_highlights WHERE group_id = ${groupId} RETURNING group_id`;
      return rows.length;
    },
  };
}
