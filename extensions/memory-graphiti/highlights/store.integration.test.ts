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
  const C = `ok_hl_c_${run}`;
  const N = `ok_hl_n_${run}`;
  const R = `ok_hl_r_${run}`;
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
      await sql`DELETE FROM lp_memory_highlights WHERE group_id IN (${A}, ${B}, ${C}, ${N}, ${R})`;
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

  it("put on a group with no row writes nothing (a forget that ran first stays total)", async () => {
    expect(await store.get(A)).toBeNull();
    expect(
      await store.put(A, { state: "ready", payload: [hl("hl_x", ["e_x"])] }, await store.clock()),
    ).toBe(false);
    expect(await store.get(A)).toBeNull();
  });

  it("put then get round-trips the payload exactly", async () => {
    expect(await store.claimOnDemand(A, 3)).toBe(true);
    const payload = [hl("hl_1", ["e_1", "e_2"]), hl("hl_2", ["e_2", "e_3"])];
    expect(await store.put(A, { state: "ready", payload }, await store.clock())).toBe(true);
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
    await store.claimOnDemand(B, 3);
    await store.put(B, { state: "empty", payload: [] }, await store.clock());
    expect(await store.get(B)).toMatchObject({ state: "empty", payload: [], sourceFactIds: [] });
    expect((await store.get(A))?.state).toBe("ready");
  });

  it("deleteGroup removes the row and reports the count", async () => {
    expect(await store.deleteGroup(B)).toBe(1);
    expect(await store.get(B)).toBeNull();
    expect(await store.deleteGroup(B)).toBe(0);
  });

  /** Backdate a row's stale mark (the debounce is measured on the database clock). */
  const staleAgo = (g: string, seconds: number) =>
    sql`UPDATE lp_memory_highlights
        SET stale_since = now() - make_interval(secs => ${seconds}) WHERE group_id = ${g}`;

  it("claimOnDemand: a first read inserts an unavailable placeholder and takes slot 1", async () => {
    expect(await store.claimOnDemand(N, 3)).toBe(true);
    expect(await store.get(N)).toMatchObject({
      state: "unavailable",
      payload: [],
      sourceFactIds: [],
    });
    const row = await sql<{ n: number; today: boolean }>`
      SELECT ondemand_count AS n, ondemand_day = (now() AT TIME ZONE 'utc')::date AS today
      FROM lp_memory_highlights WHERE group_id = ${N}`;
    expect(row[0]).toEqual({ n: 1, today: true });
  });

  it("claimOnDemand: at most `cap` per UTC day; a new day resets the count; payload untouched", async () => {
    expect(await store.claimOnDemand(C, 3)).toBe(true);
    await store.put(C, { state: "ready", payload: [hl("hl_c", ["e_c"])] }, await store.clock());
    expect(await store.claimOnDemand(C, 3)).toBe(true);
    expect(await store.claimOnDemand(C, 3)).toBe(true);
    expect(await store.claimOnDemand(C, 3)).toBe(false);
    expect((await store.get(C))?.state).toBe("ready");
    await sql`UPDATE lp_memory_highlights SET ondemand_day = ondemand_day - 1 WHERE group_id = ${C}`;
    // A new day: the count restarts at 1, so exactly 3 more claims succeed.
    expect(await store.claimOnDemand(C, 3)).toBe(true);
    const n = await sql<{ n: number }>`
      SELECT ondemand_count AS n FROM lp_memory_highlights WHERE group_id = ${C}`;
    expect(n[0].n).toBe(1);
    expect(await store.claimOnDemand(C, 3)).toBe(true);
    expect(await store.claimOnDemand(C, 3)).toBe(true);
    expect(await store.claimOnDemand(C, 3)).toBe(false);
  });

  it("claimOnDemand under concurrency never exceeds the cap", async () => {
    const g = `${C}_race`;
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => store.claimOnDemand(g, 3)));
      expect(results.filter(Boolean)).toHaveLength(3);
    } finally {
      await sql`DELETE FROM lp_memory_highlights WHERE group_id = ${g}`;
    }
  });

  it("staleDue: only groups stale for at least the debounce and still under today's cap", async () => {
    // A: stale 3 minutes, under cap -> due. C: capped today -> not due. N: stale 30 s -> not yet.
    await store.markStale(A);
    await staleAgo(A, 180);
    await sql`UPDATE lp_memory_highlights SET ondemand_day = (now() AT TIME ZONE 'utc')::date,
              ondemand_count = 3 WHERE group_id = ${C}`;
    await store.markStale(C);
    await staleAgo(C, 180);
    await store.markStale(N);
    await staleAgo(N, 30);
    const due = await store.staleDue({ debounceSec: 120, cap: 3, limit: 100 });
    expect(due).toContain(A);
    expect(due).not.toContain(C);
    expect(due).not.toContain(N);
  });

  it("nightlyDue: every stale group, whatever its on-demand count", async () => {
    const due = await store.nightlyDue(100);
    expect(due).toEqual(expect.arrayContaining([A, C, N]));
  });

  it("dropCiting: removes every highlight citing a fact, keeps order, recomputes ids, marks stale", async () => {
    await store.claimOnDemand(R, 3);
    await store.put(
      R,
      {
        state: "ready",
        payload: [
          hl("hl_1", ["e_1", "e_2"]),
          hl("hl_2", ["e_3"]),
          hl("hl_3", ["e_2", "e_4"]),
          hl("hl_4", ["e_5"]),
        ],
      },
      await store.clock(),
    );
    expect(await store.dropCiting(R, ["e_2"])).toBe(2);
    const row = await store.get(R);
    expect(row?.payload.map((h) => h.id)).toEqual(["hl_2", "hl_4"]);
    expect(row?.sourceFactIds.toSorted()).toEqual(["e_3", "e_5"]);
    expect(row?.state).toBe("ready");
    expect(row?.staleSince).toBeInstanceOf(Date);
    // Nothing cites e_9: no change, 0.
    expect(await store.dropCiting(R, ["e_9"])).toBe(0);
    // Dropping the rest leaves a ready row with no highlights as unavailable (regenerates).
    expect(await store.dropCiting(R, ["e_3", "e_5"])).toBe(2);
    expect(await store.get(R)).toMatchObject({
      state: "unavailable",
      payload: [],
      sourceFactIds: [],
    });
    // A group with no row: 0, nothing created.
    expect(await store.dropCiting(`${R}_none`, ["e_1"])).toBe(0);
    expect(await store.get(`${R}_none`)).toBeNull();
  });
});
