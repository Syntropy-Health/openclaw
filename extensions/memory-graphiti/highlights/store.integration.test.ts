/**
 * Highlight cache against REAL Postgres (A&D §5, PLAN P4.1).
 *
 * Requires DATABASE_URL; skipped otherwise. Use a LOCAL or disposable database
 * only: the suite writes and deletes its own rows (group ids carry a per-run suffix).
 *
 * Run: DATABASE_URL=<url> pnpm vitest run extensions/memory-graphiti/highlights/store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureReceiptSchema } from "../receipts.js";
import { createPgHighlightStore, type HighlightStore } from "./store.js";
import type { Highlight } from "./types.js";

const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

type Sql = Parameters<typeof createPgHighlightStore>[0] & { end: (o?: object) => Promise<void> };

const hl = (id: string, factIds: string[]): Highlight => ({
  id,
  category: "sleep",
  title: `title ${id} with "quotes" & ünïcödé`,
  body: "One sentence.",
  first_seen: "2026-10-01",
  last_seen: "2026-10-25",
  occurrences: 2,
  recurring: false,
  score: 0.5,
  sources: factIds.map((f) => ({ fact_id: f, fact: `fact ${f}`, last_seen: "2026-10-25" })),
});

describeIf("highlight store (real Postgres)", () => {
  const run = `${Date.now()}`;
  const A = `ok_hl_a_${run}`;
  const B = `ok_hl_b_${run}`;
  let sql: Sql;
  let store: HighlightStore;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(DB_URL!, {
      ssl: { rejectUnauthorized: false },
      max: 3,
      idle_timeout: 5,
    }) as unknown as Sql;
    await ensureReceiptSchema(sql);
    store = createPgHighlightStore(sql);
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM lp_memory_highlights WHERE group_id IN (${A}, ${B})`;
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
      ondemand_count: "integer",
      ondemand_day: "date",
      payload: "jsonb",
      source_fact_ids: "ARRAY",
      stale_since: "timestamp with time zone",
      state: "text",
    });
  });

  it("get on an unknown group is null; put then get round-trips the payload exactly", async () => {
    expect(await store.get(A)).toBeNull();
    const payload = [hl("hl_1", ["e_1", "e_2"]), hl("hl_2", ["e_2", "e_3"])];
    await store.put(A, { state: "ready", payload }, await store.clock());
    const row = await store.get(A);
    expect(row).toMatchObject({ state: "ready", payload, staleSince: null });
    expect(row?.sourceFactIds.toSorted()).toEqual(["e_1", "e_2", "e_3"]);
    expect(row?.generatedAt).toBeInstanceOf(Date);
    const t = await sql<{ t: string }>`
      SELECT jsonb_typeof(payload) AS t FROM lp_memory_highlights WHERE group_id = ${A}`;
    expect(t[0].t).toBe("array");
  });

  it("markStale sets stale_since on an existing row only", async () => {
    await store.markStale(A);
    expect((await store.get(A))?.staleSince).toBeInstanceOf(Date);
    await store.markStale(B); // no row: nothing to mark, no row created
    expect(await store.get(B)).toBeNull();
  });

  it("put clears stale_since only when no stale mark arrived after the generation started", async () => {
    // A mark after the run started survives the put: that turn is not yet reflected.
    // Generation start times come from the database clock (store.clock), never the
    // gateway's, so app/database skew cannot lose or keep a mark wrongly.
    const startedBefore = await store.clock();
    await store.markStale(A);
    await store.put(A, { state: "ready", payload: [hl("hl_1", ["e_1"])] }, startedBefore);
    expect((await store.get(A))?.staleSince).toBeInstanceOf(Date);

    // A put from a run that started after the latest mark clears it.
    await store.put(A, { state: "ready", payload: [hl("hl_1", ["e_1"])] }, await store.clock());
    expect((await store.get(A))?.staleSince).toBeNull();
  });

  it("empty state stores an empty payload and no source ids; groups never cross", async () => {
    await store.put(B, { state: "empty", payload: [] }, await store.clock());
    expect(await store.get(B)).toMatchObject({ state: "empty", payload: [], sourceFactIds: [] });
    expect((await store.get(A))?.state).toBe("ready");
  });

  it("deleteGroup removes the row and reports the count", async () => {
    expect(await store.deleteGroup(B)).toBe(1);
    expect(await store.get(B)).toBeNull();
    expect(await store.deleteGroup(B)).toBe(0);
  });
});
