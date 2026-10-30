/**
 * Concurrent first boots against a fresh database (real Postgres). Several
 * sessions running ensureUserSchema at the same moment must all succeed:
 * CREATE ... IF NOT EXISTS alone does not cover two sessions creating the same
 * object at once, so each statement goes through retryDdlRace.
 *
 * Requires DATABASE_URL; skipped otherwise. Use a LOCAL or disposable database
 * only: each round creates and drops its own run-suffixed schema.
 */
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { ensureUserSchema } from "./db.js";

const DB_URL = process.env.DATABASE_URL;
const describeIf = DB_URL ? describe : describe.skip;

describeIf("ensureUserSchema under concurrent first boots (real Postgres)", () => {
  it("6 concurrent sessions on a fresh schema all succeed, 5 rounds", async () => {
    // Same options as the sibling PG suites (TLS without CA pinning, short idle).
    const opts = { ssl: { rejectUnauthorized: false }, idle_timeout: 5 } as const;
    const admin = postgres(DB_URL!, { ...opts, max: 1 });
    try {
      for (let round = 0; round < 5; round++) {
        const schema = `pui_concurrent_${Date.now()}_${round}`; // run-suffixed identifier
        await admin.unsafe(`CREATE SCHEMA ${schema}`);
        const conns = Array.from({ length: 6 }, () =>
          postgres(DB_URL!, { ...opts, max: 1, connection: { search_path: schema } }),
        );
        try {
          const results = await Promise.allSettled(conns.map((c) => ensureUserSchema(c)));
          expect(results.filter((r) => r.status === "rejected")).toEqual([]);
          const tables = await admin<{ n: number }[]>`
            SELECT count(*)::int AS n FROM information_schema.tables
            WHERE table_schema = ${schema} AND table_name IN ('lp_users', 'lp_user_channels')`;
          expect(tables[0].n).toBe(2);
        } finally {
          await Promise.all(conns.map((c) => c.end({ timeout: 5 })));
          await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
});
