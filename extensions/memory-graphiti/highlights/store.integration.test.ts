/**
 * Highlight cache against REAL Postgres (A&D §5, PLAN P4.1).
 *
 * Requires DATABASE_URL; skipped otherwise. Use a LOCAL or disposable database
 * only: the suite writes and deletes its own rows (group ids carry a per-run suffix).
 *
 * The store's behaviour is the shared contract (testing/highlight-store.contract.ts),
 * which the in-memory fake also runs. This file adds what only the database has:
 * the schema, the stored jsonb shape, and atomicity under concurrency.
 *
 * Run: DATABASE_URL=<url> pnpm vitest run extensions/memory-graphiti/highlights/store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureReceiptSchema } from "../receipts.js";
import {
  contractHighlight as hl,
  describeHighlightStoreContract,
} from "../testing/highlight-store.contract.js";
import { createPgHighlightStore, type HighlightStore } from "./store.js";

const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

type Sql = Parameters<typeof createPgHighlightStore>[0] & { end: (o?: object) => Promise<void> };

const connect = async (): Promise<Sql> => {
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB_URL!, {
    ssl: { rejectUnauthorized: false },
    max: 3,
    idle_timeout: 5,
  }) as unknown as Sql;
  try {
    await ensureReceiptSchema(sql);
  } catch (err) {
    await sql.end({ timeout: 5 });
    throw err;
  }
  return sql;
};

describeHighlightStoreContract(describeIf, "Postgres", async () => {
  const sql = await connect();
  let unknown = 0;
  /** A hook on a group with no row must fail loudly, as the fake's does. */
  const one = async (rows: Promise<unknown[]>, g: string) => {
    if ((await rows).length !== 1) {
      throw new Error(`no row for ${g}`);
    }
  };
  return {
    store: createPgHighlightStore(sql, { onUnknownCategory: (n) => (unknown += n) }),
    unknownCategoryCount: () => unknown,
    prefix: `ok_hlc_${Date.now()}`,
    staleAgo: (g, seconds) =>
      one(
        sql`UPDATE lp_memory_highlights
          SET stale_since = now() - make_interval(secs => ${seconds})
          WHERE group_id = ${g} RETURNING 1`,
        g,
      ),
    previousDay: (g) =>
      one(
        sql`UPDATE lp_memory_highlights SET ondemand_day = ondemand_day - 1
          WHERE group_id = ${g} RETURNING 1`,
        g,
      ),
    capToday: (g, count) =>
      one(
        sql`UPDATE lp_memory_highlights SET ondemand_day = (now() AT TIME ZONE 'utc')::date,
          ondemand_count = ${count} WHERE group_id = ${g} RETURNING 1`,
        g,
      ),
    expireLease: (g) =>
      one(
        sql`UPDATE lp_memory_highlights SET regen_lease_until = now() - interval '1 second'
          WHERE group_id = ${g} RETURNING 1`,
        g,
      ),
    close: () => sql.end({ timeout: 5 }),
  };
});

describeIf("highlight store (real Postgres only)", () => {
  const run = `${Date.now()}`;
  const groups: string[] = [];
  const group = (tag: string) => {
    const g = `ok_hl_${tag}_${run}`;
    groups.push(g);
    return g;
  };
  let sql: Sql;
  let store: HighlightStore;

  beforeAll(async () => {
    sql = await connect();
    store = createPgHighlightStore(sql);
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM lp_memory_highlights WHERE group_id = ANY(${groups})`;
      await sql.end({ timeout: 5 });
    }
  });

  it("the table has the A&D §5 columns", async () => {
    const cols = await sql<{ column_name: string; data_type: string }>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'lp_memory_highlights' ORDER BY column_name`;
    expect(Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]))).toEqual({
      generated_at: "timestamp with time zone",
      group_id: "text",
      epoch: "bigint",
      ondemand_count: "integer",
      ondemand_day: "date",
      payload: "jsonb",
      regen_lease_until: "timestamp with time zone",
      source_fact_ids: "ARRAY",
      stale_since: "timestamp with time zone",
      state: "text",
    });
  });

  it("the payload is stored as a jsonb array; a first read takes slot 1 of today (UTC)", async () => {
    const g = group("shape");
    expect(await store.claimOnDemand(g, 3, { create: true })).toBe(true);
    const slot = await sql<{ n: number; today: boolean }>`
      SELECT ondemand_count AS n, ondemand_day = (now() AT TIME ZONE 'utc')::date AS today
      FROM lp_memory_highlights WHERE group_id = ${g}`;
    expect(slot[0]).toEqual({ n: 1, today: true });
    const epoch = (await store.get(g))!.epoch;
    await store.put(
      g,
      { state: "ready", payload: [hl("hl_1", ["e_1"])] },
      await store.clock(),
      epoch,
    );
    const t = await sql<{ t: string }>`
      SELECT jsonb_typeof(payload) AS t FROM lp_memory_highlights WHERE group_id = ${g}`;
    expect(t[0].t).toBe("array");
  });

  it("claimOnDemand under concurrency never exceeds the cap", async () => {
    const g = group("claim_race");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.claimOnDemand(g, 3, { create: true })),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("acquireLease under concurrency has exactly one winner", async () => {
    const g = group("lease_race");
    await store.claimOnDemand(g, 3, { create: true });
    const race = await Promise.all(Array.from({ length: 6 }, () => store.acquireLease(g, 120)));
    expect(race.filter(Boolean)).toHaveLength(1);
  });
});
