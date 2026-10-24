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

import { randomBytes } from "node:crypto";
import {
  ensureSyntropySchema,
  getSyntropyToken,
  migrateTokenToCipher,
  PlaintextTokenRefusedError,
  readStoredToken,
  upsertSyntropyToken,
} from "./db.js";
import { TokenCipher, TokenCipherError } from "./token-cipher.js";
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

/** Mock `SyntropyVault` — get/set/delete spies.
 *
 * `SyntropyVault` is a class with a private `sql` member, so a plain object
 * literal can't structurally satisfy it. The cast through `unknown` is
 * justified here because we control all call sites — the mock only ever
 * has its public-method surface invoked by `db.ts`.
 *
 * SCOPE NOTE: this mock bypasses `SyntropyVault`'s constructor guards
 * (the empty-name checks in vault.ts). Those invariants are exercised in
 * `vault.test.ts`. Here we only verify that `db.ts` orchestrates the Vault
 * API surface (call shape + ordering) — NOT that the Vault class itself
 * enforces its preconditions. Don't widen this mock to act as a full
 * SyntropyVault substitute; keep the boundary so each unit test stays
 * focused. */
function makeMockVault(initialStore: Record<string, string> = {}): SyntropyVault {
  const store: Record<string, string> = { ...initialStore };
  return {
    get: vi.fn(async (name: string) => store[name] ?? null),
    set: vi.fn(async (name: string, value: string) => {
      store[name] = value;
    }),
    delete: vi.fn(async (name: string) => {
      delete store[name];
    }),
  } as unknown as SyntropyVault;
}

describe("ensureSyntropySchema", () => {
  it("issues CREATE TABLE + idempotent ALTER statements", async () => {
    // Four queries: CREATE TABLE, ALTER ... DROP NOT NULL, ADD vault_secret_name, ADD token_ciphertext
    const { sql, calls } = makeMockSql([[], [], [], []]);
    await ensureSyntropySchema(sql);

    expect(calls).toHaveLength(4);
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
    expect(calls[3]!.query).toMatch(/ADD COLUMN IF NOT EXISTS token_ciphertext TEXT/);
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
  it("RED: with no cipher, no vault and no opt-in, REFUSES and writes nothing", async () => {
    const { sql, calls } = makeMockSql();
    vi.stubEnv("OPENCLAW_ALLOW_PLAINTEXT_TOKENS", "");
    try {
      await expect(
        upsertSyntropyToken(sql, null, "user-uuid-3", "sj_legacy", "pairing"),
      ).rejects.toBeInstanceOf(PlaintextTokenRefusedError);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls).toHaveLength(0);
  });

  it("falls back to plaintext auth_token when vault is null AND the dev opt-in is set", async () => {
    const { sql, calls } = makeMockSql();
    vi.stubEnv("OPENCLAW_ALLOW_PLAINTEXT_TOKENS", "1");
    try {
      await upsertSyntropyToken(sql, null, "user-uuid-3", "sj_legacy", "pairing");
    } finally {
      vi.unstubAllEnvs();
    }

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

describe("app cipher store (Cloud SQL move, CTO #16611)", () => {
  const TOKEN = "sj_cipherpath_supersecretlongpart_42";
  const USER = "user-uuid-cipher";
  const cipher = new TokenCipher(randomBytes(32));

  it("RED: a 'DB dump' (every SQL parameter written) contains no plaintext token", async () => {
    const { sql, calls } = makeMockSql();
    const vault = makeMockVault();
    await upsertSyntropyToken(sql, vault, USER, TOKEN, "pairing", cipher);
    const written = JSON.stringify(calls.map((c) => c.params));
    expect(written).not.toContain(TOKEN);
    expect(written).not.toContain("supersecretlongpart");
    // ciphertext only: the vault is not used and the legacy column is NULLed
    expect(vault.set).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatch(/token_ciphertext/);
    expect(calls[0]!.query).toMatch(/vault_secret_name = NULL/);
    expect(calls[0]!.query).toMatch(/auth_token\s+= NULL/);
    // ...and what was written opens back to the token for this user only
    const envelope = calls[0]!.params[1] as string;
    expect(cipher.open(USER, envelope)).toBe(TOKEN);
  });

  it("GREEN: read order is ciphertext, then vault, then legacy plaintext", async () => {
    const env = cipher.seal(USER, TOKEN);
    const vault = makeMockVault({ syntropy_user_x: "from-vault" });
    expect(
      await readStoredToken(
        { token_ciphertext: env, vault_secret_name: "syntropy_user_x", auth_token: "legacy" },
        USER,
        vault,
        cipher,
      ),
    ).toBe(TOKEN);
    expect(
      await readStoredToken(
        { vault_secret_name: "syntropy_user_x", auth_token: "legacy" },
        USER,
        vault,
        cipher,
      ),
    ).toBe("from-vault");
    expect(await readStoredToken({ auth_token: "legacy" }, USER, vault, cipher)).toBe("legacy");
    expect(await readStoredToken({}, USER, vault, cipher)).toBeNull();
  });

  it("RED: a tampered ciphertext THROWS and does not fall through to an older vault copy", async () => {
    const parts = cipher.seal(USER, TOKEN).split(".");
    const ct = Buffer.from(parts[4], "base64url");
    ct[1] ^= 0x55;
    parts[4] = ct.toString("base64url");
    const vault = makeMockVault({ syntropy_user_x: "stale-vault-copy" });
    await expect(
      readStoredToken(
        { token_ciphertext: parts.join("."), vault_secret_name: "syntropy_user_x" },
        USER,
        vault,
        cipher,
      ),
    ).rejects.toMatchObject({ code: "tamper" });
    expect(vault.get).not.toHaveBeenCalled();
  });

  it("RED: an encrypted row with no cipher loaded throws, never reads as 'not paired'", async () => {
    await expect(
      readStoredToken({ token_ciphertext: cipher.seal(USER, TOKEN) }, USER, null, null),
    ).rejects.toMatchObject({ code: "no_cipher" });
  });

  it("RED: a row sealed under a rotated-away DEK fails with key_mismatch (named)", async () => {
    const old = new TokenCipher(randomBytes(32));
    await expect(
      readStoredToken({ token_ciphertext: old.seal(USER, TOKEN) }, USER, null, cipher),
    ).rejects.toBeInstanceOf(TokenCipherError);
  });

  it("getSyntropyToken reads through the same order (selects token_ciphertext)", async () => {
    const { sql, calls } = makeMockSql([
      [{ token_ciphertext: cipher.seal(USER, TOKEN), vault_secret_name: null, auth_token: null }],
    ]);
    expect(await getSyntropyToken(sql, null, USER, cipher)).toBe(TOKEN);
    expect(calls[0]!.query).toMatch(/token_ciphertext/);
  });
});

describe("review fixes (QG round on the token cipher)", () => {
  const TOKEN = "sj_reviewfix_supersecret_part_9";
  const USER = "user-uuid-review";
  const cipher = new TokenCipher(randomBytes(32));

  it("RED (re-pair after a backout): the Vault write clears token_ciphertext", async () => {
    const { sql, calls } = makeMockSql();
    await upsertSyntropyToken(sql, makeMockVault(), USER, TOKEN, "pairing", null);
    expect(calls[0]!.query).toMatch(/token_ciphertext\s+= NULL/);
  });

  it("RED (re-pair after a backout): the legacy write clears token_ciphertext", async () => {
    const { sql, calls } = makeMockSql();
    vi.stubEnv("OPENCLAW_ALLOW_PLAINTEXT_TOKENS", "1");
    try {
      await upsertSyntropyToken(sql, null, USER, TOKEN, "pairing", null);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(calls[0]!.query).toMatch(/token_ciphertext\s+= NULL/);
  });

  it("RED: a Vault reference with no Vault is a NAMED failure, not a silent 'not paired'", async () => {
    await expect(
      readStoredToken({ vault_secret_name: "syntropy_user_x" }, USER, null, null),
    ).rejects.toMatchObject({
      code: "vault_unavailable",
    });
  });

  it("RED (downgrade): with a cipher loaded and legacy reads OFF, an unencrypted row is refused", async () => {
    vi.stubEnv("OPENCLAW_TOKEN_LEGACY_READ", "0");
    try {
      await expect(
        readStoredToken({ auth_token: "planted" }, USER, null, cipher),
      ).rejects.toMatchObject({
        code: "legacy_read_disabled",
      });
      await expect(
        readStoredToken(
          { vault_secret_name: "syntropy_user_x" },
          USER,
          makeMockVault({ syntropy_user_x: "v" }),
          cipher,
        ),
      ).rejects.toMatchObject({ code: "legacy_read_disabled" });
      // an encrypted row still reads
      expect(
        await readStoredToken({ token_ciphertext: cipher.seal(USER, TOKEN) }, USER, null, cipher),
      ).toBe(TOKEN);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("migrateTokenToCipher writes only ciphertext (no plaintext in any parameter) and NULLs the old columns", async () => {
    const { sql, calls } = makeMockSql();
    await migrateTokenToCipher(sql, USER, TOKEN, cipher);
    expect(JSON.stringify(calls.map((c) => c.params))).not.toContain(TOKEN);
    expect(calls[0]!.query).toMatch(/UPDATE syntropy_tokens/);
    expect(calls[0]!.query).toMatch(/vault_secret_name = NULL, auth_token = NULL/);
    expect(cipher.open(USER, calls[0]!.params[0] as string)).toBe(TOKEN);
  });
});
