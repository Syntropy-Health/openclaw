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
   * Store a generation result. `startedAt` is store.clock() read when the run
   * began: a stale mark made after it survives (that turn is not reflected yet);
   * an older mark is cleared.
   */
  put(groupId: string, result: HighlightWrite, startedAt: Date): Promise<void>;
  /** Mark an existing row stale (now). A group with no row is left alone. */
  markStale(groupId: string): Promise<void>;
  /** Delete the group's row (forget). Returns rows removed. */
  deleteGroup(groupId: string): Promise<number>;
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
      const ids = [...new Set(result.payload.flatMap((h) => h.sources.map((s) => s.fact_id)))];
      // Payload sent as TEXT for Postgres to parse: a bare `${string}::jsonb`
      // would be JSON-encoded again by the driver and stored as a JSON string.
      const payload = JSON.stringify(result.payload);
      await sql`
        INSERT INTO lp_memory_highlights
          (group_id, payload, state, generated_at, source_fact_ids)
        VALUES (${groupId}, ${payload}::text::jsonb, ${result.state}, now(), ${ids}::text[])
        ON CONFLICT (group_id) DO UPDATE SET
          payload = EXCLUDED.payload,
          state = EXCLUDED.state,
          generated_at = EXCLUDED.generated_at,
          source_fact_ids = EXCLUDED.source_fact_ids,
          stale_since = CASE
            WHEN lp_memory_highlights.stale_since > ${startedAt} THEN lp_memory_highlights.stale_since
            ELSE NULL
          END`;
    },

    async markStale(groupId) {
      await sql`UPDATE lp_memory_highlights SET stale_since = now() WHERE group_id = ${groupId}`;
    },

    async deleteGroup(groupId) {
      const rows = await sql<{ group_id: string }>`
        DELETE FROM lp_memory_highlights WHERE group_id = ${groupId} RETURNING group_id`;
      return rows.length;
    },
  };
}
