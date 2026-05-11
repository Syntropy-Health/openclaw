/**
 * Postgres persistence tests for syntropy_tokens.
 *
 * Mocks `postgres.Sql` as a tagged-template function. Verifies:
 *   - schema-init query references the correct table + FK
 *   - upsert uses INSERT ... ON CONFLICT to replace tokens
 *   - get returns the auth_token column or null
 *
 * Live integration against a real Postgres is out of scope here — pin the
 * worktree's container test to a `LIVE_PG=1` flag if/when added.
 */

import { describe, expect, it, vi } from "vitest";
import { ensureSyntropySchema, getSyntropyToken, upsertSyntropyToken } from "./db.js";

/**
 * Build a minimal mock of `postgres.Sql` (the tagged-template function).
 *
 * `postgres` is callable as: `await sql`SELECT ...`;` — a tagged template
 * literal. We mimic that with a vi.fn that records the joined query string
 * and parameter values for each call, and returns the queued reply.
 */
function makeMockSql(replies: unknown[][] = [[]]) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  let i = 0;

  const sql = vi.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ query: strings.join("$?"), params });
    return Promise.resolve(replies[i++] ?? []);
  });

  return { sql: sql as unknown as Parameters<typeof ensureSyntropySchema>[0], calls };
}

describe("ensureSyntropySchema", () => {
  it("issues a CREATE TABLE IF NOT EXISTS on syntropy_tokens with FK to lp_users", async () => {
    const { sql, calls } = makeMockSql();
    await ensureSyntropySchema(sql);

    expect(calls).toHaveLength(1);
    const q = calls[0]!.query;
    expect(q).toMatch(/CREATE TABLE IF NOT EXISTS syntropy_tokens/);
    expect(q).toMatch(/user_id\s+UUID NOT NULL REFERENCES lp_users\(id\) ON DELETE CASCADE/);
    expect(q).toMatch(/auth_token TEXT NOT NULL/);
    expect(q).toMatch(/PRIMARY KEY \(user_id\)/);
  });
});

describe("upsertSyntropyToken", () => {
  it("INSERT ... ON CONFLICT replaces an existing token", async () => {
    const { sql, calls } = makeMockSql();
    await upsertSyntropyToken(sql, "user-uuid-1", "sj_short_long", "pairing");

    expect(calls).toHaveLength(1);
    const { query, params } = calls[0]!;
    expect(query).toMatch(/INSERT INTO syntropy_tokens/);
    expect(query).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(query).toMatch(/SET auth_token = EXCLUDED\.auth_token/);
    expect(params).toEqual(["user-uuid-1", "sj_short_long", "pairing"]);
  });

  it("defaults origin to 'pairing' when not provided", async () => {
    const { sql, calls } = makeMockSql();
    await upsertSyntropyToken(sql, "user-uuid-2", "sj_a_b");

    expect(calls[0]!.params).toEqual(["user-uuid-2", "sj_a_b", "pairing"]);
  });
});

describe("getSyntropyToken", () => {
  it("returns auth_token when a row exists", async () => {
    const { sql, calls } = makeMockSql([[{ auth_token: "sj_existing_token" }]]);

    const token = await getSyntropyToken(sql, "user-uuid-3");

    expect(token).toBe("sj_existing_token");
    expect(calls[0]!.query).toMatch(/SELECT auth_token FROM syntropy_tokens WHERE user_id =/);
    expect(calls[0]!.params).toEqual(["user-uuid-3"]);
  });

  it("returns null when no row matches", async () => {
    const { sql } = makeMockSql([[]]);
    const token = await getSyntropyToken(sql, "user-uuid-4");
    expect(token).toBeNull();
  });
});
