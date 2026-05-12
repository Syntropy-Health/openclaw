/**
 * Postgres + Vault token storage tests.
 *
 * Mocks `postgres.Sql` as a tagged-template function and `SyntropyVault`
 * as a typed stub. Covers both the vault-backed path (post-PR #13) and
 * the legacy plaintext fallback (dev-only, transition window).
 *
 * Live integration against a real Postgres + Vault is out of scope here —
 * see `vault.test.ts` for the vault-RPC contract and add a `LIVE_PG=1`
 * gated test if/when one is needed.
 */

import { describe, expect, it, vi } from "vitest";

// Mock vault.js to avoid loading @supabase/supabase-js transitively via db.ts.
// vault.ts has its own dedicated test file (vault.test.ts); here we just need
// the runtime symbol secretNameForUser + the type contract for SyntropyVault.
vi.mock("./vault.js", () => ({
  secretNameForUser: (userId: string) => `syntropy_user_${userId}`,
}));

import { ensureSyntropySchema, getSyntropyToken, upsertSyntropyToken } from "./db.js";
import type { SyntropyVault } from "./vault.js";

/**
 * Mock a `postgres.Sql` tagged-template function.
 *
 * Each call records the joined query string + parameter values and returns
 * the queued reply. The `postgres` lib's call shape is `await sql`SELECT
 * x WHERE id = ${id}`;` — a tagged template literal where `strings` is the
 * static SQL fragments and `params` is the interpolated values.
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

/** Mock `SyntropyVault` — get/set spies. */
function makeMockVault(initialStore: Record<string, string> = {}): SyntropyVault {
  const store: Record<string, string> = { ...initialStore };
  return {
    get: vi.fn(async (name: string) => store[name] ?? null),
    set: vi.fn(async (name: string, value: string) => {
      store[name] = value;
    }),
  };
}

describe("ensureSyntropySchema", () => {
  it("issues CREATE TABLE + idempotent ALTER statements", async () => {
    // Three queries: CREATE TABLE, ALTER ... DROP NOT NULL, ALTER ... ADD COLUMN
    const { sql, calls } = makeMockSql([[], [], []]);
    await ensureSyntropySchema(sql);

    expect(calls).toHaveLength(3);
    expect(calls[0]!.query).toMatch(/CREATE TABLE IF NOT EXISTS syntropy_tokens/);
    expect(calls[0]!.query).toMatch(
      /user_id\s+UUID NOT NULL REFERENCES lp_users\(id\) ON DELETE CASCADE/,
    );
    expect(calls[0]!.query).toMatch(/vault_secret_name\s+TEXT/);
    expect(calls[0]!.query).toMatch(/PRIMARY KEY \(user_id\)/);

    expect(calls[1]!.query).toMatch(
      /ALTER TABLE syntropy_tokens ALTER COLUMN auth_token DROP NOT NULL/,
    );
    expect(calls[2]!.query).toMatch(/ADD COLUMN IF NOT EXISTS vault_secret_name TEXT/);
  });
});

describe("upsertSyntropyToken — vault path (production)", () => {
  it("writes plaintext to Vault and stores ONLY the secret name in Postgres", async () => {
    const { sql, calls } = makeMockSql();
    const vault = makeMockVault();

    await upsertSyntropyToken(sql, vault, "user-uuid-1", "sj_short_long", "pairing");

    // Vault was written first
    expect(vault.set).toHaveBeenCalledTimes(1);
    expect(vault.set).toHaveBeenCalledWith("syntropy_user_user-uuid-1", "sj_short_long");

    // Postgres INSERT references vault_secret_name, NOT plaintext
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatch(
      /INSERT INTO syntropy_tokens \(user_id, vault_secret_name, auth_token, origin\)/,
    );
    expect(calls[0]!.query).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(calls[0]!.query).toMatch(/SET vault_secret_name = EXCLUDED\.vault_secret_name/);
    // Plaintext column nulled out on upsert
    expect(calls[0]!.query).toMatch(/auth_token\s+= NULL/);
    expect(calls[0]!.params).toEqual(["user-uuid-1", "syntropy_user_user-uuid-1", "pairing"]);
  });

  it("defaults origin to 'pairing' when not provided", async () => {
    const { sql, calls } = makeMockSql();
    const vault = makeMockVault();
    await upsertSyntropyToken(sql, vault, "user-uuid-2", "sj_a_b");
    expect(calls[0]!.params[2]).toBe("pairing");
  });
});

describe("upsertSyntropyToken — legacy path (dev fallback)", () => {
  it("falls back to plaintext auth_token when vault is null", async () => {
    const { sql, calls } = makeMockSql();
    await upsertSyntropyToken(sql, null, "user-uuid-3", "sj_legacy", "pairing");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatch(/INSERT INTO syntropy_tokens \(user_id, auth_token, origin\)/);
    expect(calls[0]!.query).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/);
    expect(calls[0]!.query).not.toMatch(/vault_secret_name/);
    expect(calls[0]!.params).toEqual(["user-uuid-3", "sj_legacy", "pairing"]);
  });
});

describe("getSyntropyToken", () => {
  it("returns vault-decrypted plaintext when vault_secret_name is set + vault is provided", async () => {
    const { sql, calls } = makeMockSql([
      [{ auth_token: null, vault_secret_name: "syntropy_user_u4" }],
    ]);
    const vault = makeMockVault({ syntropy_user_u4: "sj_from_vault" });

    const token = await getSyntropyToken(sql, vault, "user-uuid-4");

    expect(token).toBe("sj_from_vault");
    expect(vault.get).toHaveBeenCalledWith("syntropy_user_u4");
    expect(calls[0]!.params).toEqual(["user-uuid-4"]);
    expect(calls[0]!.query).toMatch(/SELECT auth_token, vault_secret_name/);
  });

  it("falls back to legacy auth_token plaintext when vault_secret_name is null", async () => {
    const { sql } = makeMockSql([[{ auth_token: "sj_legacy_token", vault_secret_name: null }]]);
    const vault = makeMockVault();
    const token = await getSyntropyToken(sql, vault, "user-uuid-5");
    expect(token).toBe("sj_legacy_token");
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("falls back to legacy auth_token when vault parameter is null (dev mode)", async () => {
    const { sql } = makeMockSql([
      [{ auth_token: "sj_dev_token", vault_secret_name: "syntropy_user_u6" }],
    ]);
    const token = await getSyntropyToken(sql, null, "user-uuid-6");
    expect(token).toBe("sj_dev_token");
  });

  it("returns null when no row matches the user", async () => {
    const { sql } = makeMockSql([[]]);
    const vault = makeMockVault();
    const token = await getSyntropyToken(sql, vault, "user-uuid-missing");
    expect(token).toBeNull();
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("returns null when row exists but both token columns are null", async () => {
    const { sql } = makeMockSql([[{ auth_token: null, vault_secret_name: null }]]);
    const vault = makeMockVault();
    const token = await getSyntropyToken(sql, vault, "user-uuid-empty");
    expect(token).toBeNull();
  });
});
