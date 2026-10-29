/**
 * Receipt ledger against REAL Postgres (P2.9a): episode_ids is stored as a JSON
 * ARRAY, and rows an earlier version stored as a JSON string are converted.
 *
 * Requires DATABASE_URL; skipped otherwise. Use a LOCAL or disposable database
 * only: the suite writes and deletes its own rows (group ids carry a per-run suffix).
 *
 * Run: DATABASE_URL=<url> pnpm vitest run extensions/memory-graphiti/receipts.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgReceiptLedger, ensureReceiptSchema } from "./receipts.js";

const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

type Sql = Parameters<typeof createPgReceiptLedger>[0] & {
  end: (o?: object) => Promise<void>;
};

describeIf("receipt ledger episode_ids (real Postgres)", () => {
  const run = `${Date.now()}`;
  const A = `ok_rcpt_a_${run}`;
  const LEGACY = `ok_rcpt_legacy_${run}`;
  let sql: Sql;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    sql = postgres(DB_URL!, {
      ssl: { rejectUnauthorized: false },
      max: 2,
      idle_timeout: 5,
    }) as unknown as Sql;
    await ensureReceiptSchema(sql);
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM lp_memory_receipts WHERE group_id IN (${A}, ${LEGACY})`;
      await sql.end({ timeout: 5 });
    }
  });

  const typeOf = async (group: string) =>
    (
      await sql<{ t: string; ids: unknown }>`
        SELECT jsonb_typeof(episode_ids) AS t, episode_ids AS ids
        FROM lp_memory_receipts WHERE group_id = ${group} ORDER BY entry_hash`
    ).map((r) => [r.t, r.ids]);

  it("record stores episode_ids as a JSON array (one per entry hash)", async () => {
    const ledger = createPgReceiptLedger(sql);
    await ledger.record({
      groupId: A,
      entryHashes: ["h1", "h2"],
      store: "zep-cloud",
      episodeIds: ["ep_1", "ep_2"],
      contentHash: "c",
      ingestedAt: new Date().toISOString(),
    });
    await ledger.record({
      groupId: A,
      entryHashes: ["h3"],
      store: "zep-cloud",
      episodeIds: [],
      contentHash: "c",
      ingestedAt: new Date().toISOString(),
    });
    expect(await typeOf(A)).toEqual([
      ["array", ["ep_1", "ep_2"]],
      ["array", ["ep_1", "ep_2"]],
      ["array", []],
    ]);
    const inArray = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM lp_memory_receipts
      WHERE group_id = ${A} AND episode_ids ? 'ep_2'`;
    expect(inArray[0].n).toBe(2);
  });

  it("ensureReceiptSchema converts legacy string rows to arrays, and is idempotent", async () => {
    // A row exactly as the earlier version wrote it: a JSON string holding the array.
    const legacy = JSON.stringify(["ep_old_1", "ep_old_2"]);
    await sql`
      INSERT INTO lp_memory_receipts
        (group_id, entry_hash, store, episode_ids, content_hash, ingested_at)
      VALUES (${LEGACY}, 'h_old', 'zep-cloud', to_jsonb(${legacy}::text), 'c', now())`;
    expect(await typeOf(LEGACY)).toEqual([["string", legacy]]);

    await ensureReceiptSchema(sql);
    expect(await typeOf(LEGACY)).toEqual([["array", ["ep_old_1", "ep_old_2"]]]);

    await ensureReceiptSchema(sql);
    expect(await typeOf(LEGACY)).toEqual([["array", ["ep_old_1", "ep_old_2"]]]);
  });

  it("a migrated legacy row is found by the tombstone lookup (P2.9a feeds remove)", async () => {
    const r = await createPgReceiptLedger(sql).entryHashesForEpisodes(LEGACY, ["ep_old_1"]);
    expect(r).toEqual({ hashes: ["h_old"], untracked: 0 });
  });

  it("entryHashesForEpisodes: entry hashes whose receipts cite any episode; untracked counted", async () => {
    const ledger = createPgReceiptLedger(sql);
    const G2 = `${A}_ep`;
    const base = { store: "zep-cloud", contentHash: "c", ingestedAt: new Date().toISOString() };
    await ledger.record({
      ...base,
      groupId: G2,
      entryHashes: ["h_a1", "h_a2"],
      episodeIds: ["ep_a"],
    });
    await ledger.record({
      ...base,
      groupId: G2,
      entryHashes: ["h_b"],
      episodeIds: ["ep_b", "ep_c"],
    });
    await ledger.record({
      ...base,
      groupId: `${G2}_other`,
      entryHashes: ["h_x"],
      episodeIds: ["ep_a"],
    });
    try {
      const r = await ledger.entryHashesForEpisodes(G2, ["ep_a", "ep_c", "ep_none"]);
      expect(r.hashes.toSorted()).toEqual(["h_a1", "h_a2", "h_b"]);
      expect(r.untracked).toBe(1); // ep_none has no receipt
      // Another group's receipt for the same episode id is never returned.
      expect(r.hashes).not.toContain("h_x");
      expect(await ledger.entryHashesForEpisodes(G2, [])).toEqual({ hashes: [], untracked: 0 });
    } finally {
      await sql`DELETE FROM lp_memory_receipts WHERE group_id IN (${G2}, ${`${G2}_other`})`;
    }
  });

  it("concurrent first boots on an empty schema all succeed (CREATE IF NOT EXISTS races)", async () => {
    const postgres = (await import("postgres")).default;
    const schema = `mg_ddl_race_${run}`; // run-suffixed identifier
    await (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe(
      `CREATE SCHEMA ${schema}`,
    );
    const conns = Array.from(
      { length: 6 },
      () =>
        postgres(DB_URL!, {
          ssl: { rejectUnauthorized: false },
          max: 1,
          idle_timeout: 5,
          connection: { search_path: schema },
        }) as unknown as Sql,
    );
    try {
      const results = await Promise.allSettled(conns.map((c) => ensureReceiptSchema(c)));
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      const tables = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = ${schema} AND table_name LIKE 'lp_memory_%'`;
      expect(tables[0].n).toBe(6);
    } finally {
      await Promise.all(conns.map((c) => c.end({ timeout: 5 })));
      await (sql as unknown as { unsafe: (q: string) => Promise<unknown> }).unsafe(
        `DROP SCHEMA IF EXISTS ${schema} CASCADE`,
      );
    }
  });
});
