/**
 * RecallStore against REAL Postgres (A&D §8, R10 store; condition #17023).
 *
 * Requires DATABASE_URL; skipped otherwise. Use a LOCAL or disposable database
 * only — the suite creates the plugin tables and writes and deletes its own rows
 * (group ids carry a per-run suffix).
 *
 * Run: DATABASE_URL=<url> pnpm vitest run extensions/memory-graphiti/recall-store.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgRecallStore, type RecallItem, type RecallStore } from "./recall-store.js";
import { ensureReceiptSchema } from "./receipts.js";

const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

type Sql = Parameters<typeof createPgRecallStore>[0] & { end: (o?: object) => Promise<void> };

/** A process-local store: what a gateway would have WITHOUT Postgres. RED-arm only. */
function createInMemoryRecallStore(): RecallStore {
  const rows = new Map<string, { items: RecallItem[]; state: "ready" | "timed_out"; at: string }>();
  const k = (g: string, t: string) => `${g}\u0000${t}`;
  return {
    async write(g, t, items, state) {
      rows.set(k(g, t), { items, state, at: new Date().toISOString() });
    },
    async read(g, t) {
      const r = rows.get(k(g, t));
      return r ? { turnId: t, ...r } : null;
    },
    async latest() {
      return null;
    },
    async deleteGroup() {
      return 0;
    },
    async forgetGroup() {
      return 0;
    },
    async deleteCitingFacts() {
      return 0;
    },
  };
}

const items = (n: number): RecallItem[] =>
  Array.from({ length: n }, (_, i) => ({
    rank: i + 1,
    fact_id: `e_${i + 1}`,
    fact: `fact ${i + 1} with "quotes" & <tags> and ünïcödé`,
    last_seen: i % 2 ? null : "2026-10-20",
  }));

describeIf("RecallStore (real Postgres)", () => {
  const run = `${Date.now()}`;
  const A = `ok_recall_a_${run}`;
  const B = `ok_recall_b_${run}`;
  const C = `ok_recall_c_${run}`;
  const sqls: Sql[] = [];

  const open = async (): Promise<Sql> => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB_URL!, {
      ssl: { rejectUnauthorized: false },
      max: 2,
      idle_timeout: 5,
    }) as unknown as Sql;
    sqls.push(sql);
    return sql;
  };

  beforeAll(async () => {
    await ensureReceiptSchema(await open());
  });

  afterAll(async () => {
    const sql = sqls[0];
    if (sql) {
      await sql`DELETE FROM lp_memory_recall WHERE group_id IN (${A}, ${B}, ${C})`;
      await sql`DELETE FROM lp_memory_recall_block WHERE group_id IN (${A}, ${B}, ${C})`;
    }
    for (const s of sqls) {
      await s.end({ timeout: 5 });
    }
  });

  it("cross-instance: written through store A, read through a FRESH store B, byte-identical", async () => {
    const a = createPgRecallStore(await open());
    const b = createPgRecallStore(await open()); // another pool: another gateway instance
    const written = items(4);
    await a.write(A, "resp_cross", written, "ready");
    const r = await b.read(A, "resp_cross");
    expect(r?.state).toBe("ready");
    expect(JSON.stringify(r?.items)).toBe(JSON.stringify(written));
  });

  it("RED arm: a process-local (in-memory) store FAILS the same cross-instance arm", async () => {
    const a = createInMemoryRecallStore();
    const b = createInMemoryRecallStore();
    await a.write(A, "resp_cross", items(4), "ready");
    expect(await b.read(A, "resp_cross")).toBeNull(); // the panel would answer `none`
  });

  it("TTL: a row older than 10 minutes reads as none (read and latest)", async () => {
    const sql = await open();
    const store = createPgRecallStore(sql);
    await store.write(B, "resp_old", items(1), "ready");
    await sql`UPDATE lp_memory_recall SET at = now() - interval '11 minutes'
              WHERE group_id = ${B} AND turn_id = 'resp_old'`;
    expect(await store.read(B, "resp_old")).toBeNull();
    expect(await store.latest(B)).toBeNull();
    await sql`UPDATE lp_memory_recall SET at = now() - interval '9 minutes'
              WHERE group_id = ${B} AND turn_id = 'resp_old'`;
    expect((await store.read(B, "resp_old"))?.turnId).toBe("resp_old"); // control
    await store.deleteGroup(B);
  });

  it("cap: the 6th write evicts the oldest; at most 5 rows per group", async () => {
    const sql = await open();
    const store = createPgRecallStore(sql);
    for (let i = 1; i <= 6; i++) {
      await store.write(A, `resp_cap_${i}`, items(1), "ready");
    }
    const rows = await sql<{ turn_id: string }>`
      SELECT turn_id FROM lp_memory_recall WHERE group_id = ${A} ORDER BY at`;
    expect(rows.map((r) => r.turn_id)).toEqual([
      "resp_cap_2",
      "resp_cap_3",
      "resp_cap_4",
      "resp_cap_5",
      "resp_cap_6",
    ]);
    expect(await store.read(A, "resp_cap_1")).toBeNull();
    // Re-writing an existing turn does not evict a 5th one.
    await store.write(A, "resp_cap_4", items(2), "ready");
    expect((await sql`SELECT 1 FROM lp_memory_recall WHERE group_id = ${A}`).length).toBe(5);
    expect((await store.read(A, "resp_cap_4"))?.items).toHaveLength(2);
  });

  it("cross-user: another group's turn id reads none", async () => {
    const store = createPgRecallStore(await open());
    await store.write(A, "resp_a_only", items(2), "ready");
    expect(await store.read(B, "resp_a_only")).toBeNull();
    expect((await store.read(A, "resp_a_only"))?.items).toHaveLength(2);
  });

  it("latest returns the newest turn; timed_out records carry no items", async () => {
    const store = createPgRecallStore(await open());
    await store.deleteGroup(B);
    await store.write(B, "resp_l1", items(1), "ready");
    await store.write(B, "resp_l2", [], "timed_out");
    expect(await store.latest(B)).toMatchObject({
      turnId: "resp_l2",
      state: "timed_out",
      items: [],
    });
  });

  it("deleteCitingFacts removes only the group's rows that cite a fact; deleteGroup removes the rest", async () => {
    const store = createPgRecallStore(await open());
    await store.deleteGroup(B);
    await store.write(B, "resp_cite", items(3), "ready"); // cites e_1..e_3
    await store.write(
      B,
      "resp_other",
      [items(1)[0]].map((x) => ({ ...x, fact_id: "e_9" })),
      "ready",
    );
    await store.write(A, "resp_a_cite", items(3), "ready"); // A also cites e_2
    expect(await store.deleteCitingFacts(B, ["e_2"])).toBe(1);
    expect(await store.read(B, "resp_cite")).toBeNull();
    expect(await store.read(B, "resp_other")).not.toBeNull();
    expect(await store.read(A, "resp_a_cite")).not.toBeNull(); // other group untouched
    expect(await store.deleteGroup(B)).toBe(1);
    expect(await store.latest(B)).toBeNull();
  });

  it("sweep: any write deletes ANOTHER group's expired rows (not only the writer's)", async () => {
    const sql = await open();
    const store = createPgRecallStore(sql);
    await store.write(C, "resp_stale", items(1), "ready");
    await sql`UPDATE lp_memory_recall SET at = now() - interval '11 minutes'
              WHERE group_id = ${C} AND turn_id = 'resp_stale'`;
    await store.write(B, "resp_any", items(1), "ready"); // a different group writes
    const left = await sql`SELECT 1 FROM lp_memory_recall WHERE group_id = ${C}`;
    expect(left.length).toBe(0);
    await store.deleteGroup(B);
  });

  it("forget blocks: a write after forgetGroup is refused (no row)", async () => {
    const sql = await open();
    const store = createPgRecallStore(sql);
    await store.write(C, "resp_before", items(1), "ready");
    expect(await store.forgetGroup(C)).toBe(1);
    await store.write(C, "resp_after", items(2), "ready");
    expect(await store.read(C, "resp_after")).toBeNull();
    expect((await sql`SELECT 1 FROM lp_memory_recall WHERE group_id = ${C}`).length).toBe(0);
    const [blk] = await sql<{ mins: number }>`
      SELECT EXTRACT(EPOCH FROM (until - now())) / 60 AS mins
      FROM lp_memory_recall_block WHERE group_id = ${C}`;
    expect(Number(blk.mins)).toBeGreaterThan(10.5);
    expect(Number(blk.mins)).toBeLessThanOrEqual(11);
  });

  it("the block does not affect another group", async () => {
    const store = createPgRecallStore(await open());
    await store.forgetGroup(C);
    await store.write(B, "resp_b_free", items(1), "ready");
    expect(await store.read(B, "resp_b_free")).not.toBeNull();
    await store.deleteGroup(B);
  });

  it("once the block has expired, writes work again (and the expired block is swept)", async () => {
    const sql = await open();
    const store = createPgRecallStore(sql);
    await store.forgetGroup(C);
    await sql`UPDATE lp_memory_recall_block SET until = now() - interval '1 second'
              WHERE group_id = ${C}`;
    await store.write(C, "resp_again", items(1), "ready");
    expect(await store.read(C, "resp_again")).not.toBeNull();
    expect((await sql`SELECT 1 FROM lp_memory_recall_block WHERE group_id = ${C}`).length).toBe(0);
    await store.deleteGroup(C);
  });

  it("RACE: a recall write started before a forget but landing after it commits nothing", async () => {
    const sql = await open();
    const store = createPgRecallStore(sql);
    await sql`DELETE FROM lp_memory_recall_block WHERE group_id = ${C}`;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The turn's recall started (search done, items in hand); its write is delayed.
    const lateWrite = (async () => {
      await gate;
      await store.write(C, "resp_late", items(3), "ready");
    })();
    await createPgRecallStore(await open()).forgetGroup(C); // forget on another instance
    release();
    await lateWrite;
    expect(await store.read(C, "resp_late")).toBeNull();
    expect(await store.latest(C)).toBeNull();
  });
});
