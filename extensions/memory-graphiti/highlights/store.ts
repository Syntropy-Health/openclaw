import type { Highlight, HighlightCacheState, HighlightSource } from "./types.js";

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
  /**
   * Row version, from a database sequence: new on every insert and bumped by every
   * content change other than a generation (dropCiting). A regeneration writes
   * only if the epoch it read is still current, so a remove or forget-and-recreate
   * on ANY instance during the run wins (the group lock is per process).
   */
  epoch: string;
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
   * Store a generation result into the group's EXISTING row, only while its epoch
   * is still `epoch` (read with the row when the run began); returns whether it
   * wrote. It never creates a row (only a first read's claim does), so a forget
   * stays total and a remove is never undone, on any instance. Clears the
   * regeneration lease. `startedAt` is
   * store.clock() read when the run began: a stale mark made after it survives
   * (that turn is not reflected yet); an older mark is cleared.
   */
  put(groupId: string, result: HighlightWrite, startedAt: Date, epoch: string): Promise<boolean>;
  /** Mark an existing row stale (now). A group with no row is left alone. */
  markStale(groupId: string): Promise<void>;
  /** Delete the group's row (forget). Returns rows removed. */
  deleteGroup(groupId: string): Promise<number>;
  /**
   * Take one of today's (UTC, database clock) on-demand generation slots and mark
   * the row stale (a generation is pending, visible on every instance). With
   * `create`, a group with no row gets an `unavailable` placeholder holding slot 1
   * (a user's first read ONLY); without it, a missing row stays missing, so the
   * worker can never re-create a row a forget deleted. False when the cap is
   * reached or (without create) there is no row; atomic under concurrency.
   */
  claimOnDemand(groupId: string, cap: number, opts?: { create?: boolean }): Promise<boolean>;
  /**
   * Take the group's regeneration lease for `seconds` (database clock), so two
   * instances never regenerate one group at once. False while another holds it.
   */
  acquireLease(groupId: string, seconds: number): Promise<boolean>;
  /** Release the lease (also released by a successful put). */
  releaseLease(groupId: string): Promise<void>;
  /** Groups stale for at least `debounceSec` and still under today's cap. */
  staleDue(opts: { debounceSec: number; cap: number; limit: number }): Promise<string[]>;
  /** Every stale group, whatever its on-demand count (the nightly run). */
  nightlyDue(limit: number): Promise<string[]>;
  /**
   * Remove every cached highlight that cites any of these facts (remove, R7), keep
   * the rest in order, recompute source ids and mark the row stale so it
   * regenerates. A ready row left with none becomes unavailable. Returns the
   * number of highlights removed.
   */
  dropCiting(groupId: string, factIds: string[]): Promise<number>;
}

type Row = {
  state: string;
  payload: unknown;
  generated_at: Date | string;
  stale_since: Date | string | null;
  source_fact_ids: string[];
  epoch: string | number | bigint;
};

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

/**
 * Rebuild highlights in the contract's key order (A&D §1a): jsonb stores object
 * keys in its own order, and key order is part of the contract (as for recall).
 */
export function canonicalHighlights(raw: unknown): Highlight[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((x: Record<string, unknown>) => ({
    id: str(x.id),
    category: str(x.category) as Highlight["category"],
    title: str(x.title),
    body: str(x.body),
    first_seen: str(x.first_seen),
    last_seen: str(x.last_seen),
    occurrences: Number(x.occurrences),
    recurring: x.recurring === true,
    score: Number(x.score),
    sources: (Array.isArray(x.sources) ? x.sources : []).map(
      (y: Record<string, unknown>): HighlightSource => ({
        fact_id: str(y.fact_id),
        fact: str(y.fact),
        last_seen: str(y.last_seen),
      }),
    ),
  }));
}

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export function createPgHighlightStore(sql: Sql): HighlightStore {
  return {
    async clock() {
      const rows = await sql<{ now: Date | string }>`SELECT now() AS now`;
      return toDate(rows[0].now);
    },

    async get(groupId) {
      const rows = await sql<Row>`
        SELECT state, payload, generated_at, stale_since, source_fact_ids, epoch::text AS epoch
        FROM lp_memory_highlights WHERE group_id = ${groupId}`;
      const r = rows[0];
      if (!r) {
        return null;
      }
      return {
        state: r.state as HighlightCacheState,
        payload: canonicalHighlights(r.payload),
        generatedAt: toDate(r.generated_at),
        staleSince: r.stale_since === null ? null : toDate(r.stale_since),
        sourceFactIds: r.source_fact_ids,
        epoch: str(r.epoch),
      };
    },

    async put(groupId, result, startedAt, epoch) {
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
          stale_since = CASE WHEN stale_since > ${startedAt} THEN stale_since ELSE NULL END,
          regen_lease_until = NULL
        WHERE group_id = ${groupId} AND epoch = ${epoch}::bigint
        RETURNING group_id`;
      return rows.length === 1;
    },

    async markStale(groupId) {
      await sql`UPDATE lp_memory_highlights SET stale_since = now() WHERE group_id = ${groupId}`;
    },

    async claimOnDemand(groupId, cap, opts = {}) {
      if (!opts.create) {
        const rows = await sql<{ n: number }>`
          UPDATE lp_memory_highlights SET
            ondemand_count = CASE
              WHEN ondemand_day = (now() AT TIME ZONE 'utc')::date THEN ondemand_count + 1
              ELSE 1
            END,
            ondemand_day = (now() AT TIME ZONE 'utc')::date,
            stale_since = now()
          WHERE group_id = ${groupId}
            AND (ondemand_day IS DISTINCT FROM (now() AT TIME ZONE 'utc')::date
                 OR ondemand_count < ${cap})
          RETURNING ondemand_count AS n`;
        return rows.length === 1;
      }
      const rows = await sql<{ n: number }>`
        INSERT INTO lp_memory_highlights
          (group_id, payload, state, generated_at, source_fact_ids, ondemand_day, ondemand_count,
           stale_since)
        VALUES (${groupId}, '[]'::jsonb, 'unavailable', now(), '{}'::text[],
                (now() AT TIME ZONE 'utc')::date, 1, now())
        ON CONFLICT (group_id) DO UPDATE SET
          ondemand_count = CASE
            WHEN lp_memory_highlights.ondemand_day = (now() AT TIME ZONE 'utc')::date
            THEN lp_memory_highlights.ondemand_count + 1
            ELSE 1
          END,
          ondemand_day = (now() AT TIME ZONE 'utc')::date,
          stale_since = now()
        WHERE lp_memory_highlights.ondemand_day IS DISTINCT FROM (now() AT TIME ZONE 'utc')::date
           OR lp_memory_highlights.ondemand_count < ${cap}
        RETURNING ondemand_count AS n`;
      return rows.length === 1;
    },

    async acquireLease(groupId, seconds) {
      const rows = await sql<{ group_id: string }>`
        UPDATE lp_memory_highlights SET regen_lease_until = now() + make_interval(secs => ${seconds})
        WHERE group_id = ${groupId}
          AND (regen_lease_until IS NULL OR regen_lease_until < now())
        RETURNING group_id`;
      return rows.length === 1;
    },

    async releaseLease(groupId) {
      await sql`UPDATE lp_memory_highlights SET regen_lease_until = NULL WHERE group_id = ${groupId}`;
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

    async dropCiting(groupId, factIds) {
      if (factIds.length === 0) {
        return 0;
      }
      const rows = await sql<{ dropped: number }>`
        WITH cur AS (
          SELECT payload FROM lp_memory_highlights WHERE group_id = ${groupId} FOR UPDATE
        ),
        kept AS (
          SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb) AS p, count(*)::int AS n
          FROM cur, jsonb_array_elements(cur.payload) WITH ORDINALITY AS x(e, ord)
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(e -> 'sources') src
            WHERE src ->> 'fact_id' = ANY(${factIds}::text[])
          )
        ),
        total AS (SELECT jsonb_array_length(payload) AS n FROM cur)
        UPDATE lp_memory_highlights h SET
          payload = kept.p,
          source_fact_ids = ARRAY(
            SELECT DISTINCT src ->> 'fact_id'
            FROM jsonb_array_elements(kept.p) e, jsonb_array_elements(e -> 'sources') src
          ),
          state = CASE WHEN h.state = 'ready' AND kept.n = 0 THEN 'unavailable' ELSE h.state END,
          stale_since = now(),
          epoch = nextval('lp_memory_highlights_epoch')
        FROM kept, total
        WHERE h.group_id = ${groupId} AND kept.n < total.n
        RETURNING (total.n - kept.n) AS dropped`;
      return rows[0]?.dropped ?? 0;
    },

    async deleteGroup(groupId) {
      const rows = await sql<{ group_id: string }>`
        DELETE FROM lp_memory_highlights WHERE group_id = ${groupId} RETURNING group_id`;
      return rows.length;
    },
  };
}

/**
 * fact_id → the id of the first cached highlight (in served order) that cites it.
 * Joins recall items to highlights (A&D §4.6).
 */
export function highlightIdByFact(payload: readonly Highlight[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const h of payload) {
    for (const src of h.sources) {
      if (!index.has(src.fact_id)) {
        index.set(src.fact_id, h.id);
      }
    }
  }
  return index;
}
