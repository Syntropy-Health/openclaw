/**
 * RecallStore (A&D §4.6, §5): the facts injected into one agent turn, exactly as
 * injected, so the recall panel (GET /gateway/memory/recall) can show them. It is
 * the stored result of the turn's ONE searchRanked call, never a second search.
 *
 * Postgres-backed (the principal's condition, #17023): with several gateway
 * instances, the panel's request may land on an instance that never ran the turn.
 *
 * - Keyed by (opaque group id, turn id). Every lookup filters on the CALLER's
 *   group, so another user's turn id finds nothing (`none`, never 403).
 * - TTL 10 minutes, enforced in the read query; every write also sweeps expired
 *   rows of ALL groups (and expired forget blocks), using the index on `at`.
 * - About 5 rows per group: the write upserts and evicts the oldest beyond 5 in
 *   ONE statement (atomic; no transaction is held on the shared pool, see
 *   plugin-sdk/pg-pool.ts). Two writers racing for the same group can briefly
 *   leave a few more; the next write trims them.
 * - forgetGroup erases the group's rows AND blocks writes to it for 11 minutes
 *   (lp_memory_recall_block), so a turn already in flight cannot re-create a
 *   record after a forget. The write checks the block in the same statement.
 *
 * Rows hold fact text (PHI-grade), in the same database and under the same
 * controls as lp_memory_receipts. forget and remove delete them.
 */
import type { RankedFact } from "./client.js";

export const RECALL_TTL_MINUTES = 10;
export const RECALL_CAP_PER_GROUP = 5;
/** How long a forget refuses recall writes for the group (longer than the TTL). */
export const RECALL_BLOCK_MINUTES = 11;

/** One injected fact, as the panel serves it. Key order is part of the contract. */
export type RecallItem = {
  rank: number;
  fact_id: string;
  fact: string;
  /** YYYY-MM-DD: the fact's valid-since date, else when it was recorded. */
  last_seen: string | null;
};

export type RecallState = "ready" | "timed_out";

export type RecallRecord = {
  turnId: string;
  items: RecallItem[];
  state: RecallState;
  /** ISO time the record was written. */
  at: string;
};

export interface RecallStore {
  write(groupId: string, turnId: string, items: RecallItem[], state: RecallState): Promise<void>;
  /** The record for this group's turn, or null (unknown, expired, or another group's). */
  read(groupId: string, turnId: string): Promise<RecallRecord | null>;
  /** This group's most recent unexpired record, or null. */
  latest(groupId: string): Promise<RecallRecord | null>;
  /** Delete every record of the group. Returns rows removed. */
  deleteGroup(groupId: string): Promise<number>;
  /**
   * The user's forget: delete every record of the group AND refuse writes to it for
   * RECALL_BLOCK_MINUTES (a late in-flight write commits nothing). Returns rows removed.
   */
  forgetGroup(groupId: string): Promise<number>;
  /** Delete the group's records whose items cite any of these fact ids. Returns rows removed. */
  deleteCitingFacts(groupId: string, factIds: string[]): Promise<number>;
}

/** Ranked facts → recall items, in the backend's order. */
export function toRecallItems(facts: RankedFact[]): RecallItem[] {
  return facts.map((f) => ({
    rank: f.rank,
    fact_id: f.id,
    fact: f.fact,
    last_seen: (f.validAt ?? f.createdAt)?.slice(0, 10) || null,
  }));
}

/** Rebuild items in the contract's key order (jsonb stores keys in its own order). */
export function canonicalRecallItems(raw: unknown): RecallItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((x: Record<string, unknown>) => ({
    rank: Number(x.rank),
    fact_id: String(x.fact_id),
    fact: String(x.fact),
    last_seen: typeof x.last_seen === "string" ? x.last_seen : null,
  }));
}

type Sql = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

type Row = { turn_id: string; items: unknown; state: string; at: Date | string };

function toRecord(row: Row | undefined): RecallRecord | null {
  if (!row) {
    return null;
  }
  return {
    turnId: row.turn_id,
    items: canonicalRecallItems(row.items),
    state: row.state === "timed_out" ? "timed_out" : "ready",
    at: new Date(row.at).toISOString(),
  };
}

export function createPgRecallStore(sql: Sql): RecallStore {
  return {
    async write(groupId, turnId, items, state) {
      // ONE statement. The items go as a value, not a pre-stringified string: the
      // driver encodes a jsonb parameter itself (a string would be stored as a JSON
      // string scalar). In order:
      //   - sweep expired rows of every group, and expired forget blocks;
      //   - insert/update this turn UNLESS a forget blocks the group;
      //   - keep this turn plus the newest (cap - 1) other turns of the group. The
      //     deletes see the pre-statement snapshot, so the subquery excludes this
      //     turn explicitly.
      await sql`
        WITH swept AS (
          DELETE FROM lp_memory_recall WHERE at < now() - make_interval(mins => ${RECALL_TTL_MINUTES}) RETURNING 1
        ),
        swept_blocks AS (
          DELETE FROM lp_memory_recall_block WHERE until < now() RETURNING 1
        ),
        up AS (
          INSERT INTO lp_memory_recall (group_id, turn_id, items, state, at)
          SELECT ${groupId}, ${turnId}, ${canonicalRecallItems(items)}::jsonb, ${state}, now()
          WHERE NOT EXISTS ( SELECT 1 FROM lp_memory_recall_block WHERE group_id = ${groupId} AND until > now() )
          ON CONFLICT (group_id, turn_id) DO UPDATE
            SET items = EXCLUDED.items, state = EXCLUDED.state, at = EXCLUDED.at
          RETURNING turn_id
        )
        DELETE FROM lp_memory_recall
        WHERE group_id = ${groupId}
          AND turn_id <> ${turnId}
          AND turn_id NOT IN (
            SELECT turn_id FROM lp_memory_recall
            WHERE group_id = ${groupId} AND turn_id <> ${turnId}
            ORDER BY at DESC, turn_id DESC
            LIMIT ${RECALL_CAP_PER_GROUP - 1}
          )
          AND EXISTS (SELECT 1 FROM up)`;
    },
    async read(groupId, turnId) {
      const rows = await sql<Row>`
        SELECT turn_id, items, state, at FROM lp_memory_recall
        WHERE group_id = ${groupId} AND turn_id = ${turnId} AND at > now() - make_interval(mins => ${RECALL_TTL_MINUTES})`;
      return toRecord(rows[0]);
    },
    async latest(groupId) {
      const rows = await sql<Row>`
        SELECT turn_id, items, state, at FROM lp_memory_recall
        WHERE group_id = ${groupId} AND at > now() - make_interval(mins => ${RECALL_TTL_MINUTES})
        ORDER BY at DESC, turn_id DESC
        LIMIT 1`;
      return toRecord(rows[0]);
    },
    async deleteGroup(groupId) {
      const rows = await sql<{ turn_id: string }>`
        DELETE FROM lp_memory_recall WHERE group_id = ${groupId} RETURNING turn_id`;
      return rows.length;
    },
    async forgetGroup(groupId) {
      const rows = await sql<{ turn_id: string }>`
        WITH blocked AS (
          INSERT INTO lp_memory_recall_block (group_id, until)
          VALUES (${groupId}, now() + make_interval(mins => ${RECALL_BLOCK_MINUTES}))
          ON CONFLICT (group_id) DO UPDATE
            SET until = GREATEST(lp_memory_recall_block.until, EXCLUDED.until)
        )
        DELETE FROM lp_memory_recall WHERE group_id = ${groupId} RETURNING turn_id`;
      return rows.length;
    },
    async deleteCitingFacts(groupId, factIds) {
      if (factIds.length === 0) {
        return 0;
      }
      const rows = await sql<{ turn_id: string }>`
        DELETE FROM lp_memory_recall
        WHERE group_id = ${groupId}
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(items) AS item
            WHERE item->>'fact_id' = ANY(${factIds}::text[])
          )
        RETURNING turn_id`;
      return rows.length;
    },
  };
}
