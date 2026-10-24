/**
 * Syntropy token storage — persists the API token issued during pairing.
 *
 * Token storage model (post PR #12 follow-up):
 *
 *   The actual `sj_*` plaintext lives in **Supabase Vault** (`pgsodium`-
 *   backed, mobile project). The Fly.io Postgres table `syntropy_tokens`
 *   stores ONLY a reference (`vault_secret_name`) plus per-row metadata
 *   (origin, timestamps).
 *
 *   The legacy `auth_token TEXT` column is retained NULLABLE for the
 *   transition window — existing rows still have plaintext; new writes
 *   skip it. A backfill PR will migrate the remaining plaintext rows
 *   into Vault and drop the column.
 *
 * One row per `lp_users.id`. Re-pairing replaces the existing row's
 * vault secret in-place; secrets are rotated in the Vault, not duplicated.
 *
 * Cloud SQL move (CTO #16611): when a `TokenCipher` is configured
 * (token-cipher.ts), new writes store ONLY `token_ciphertext`: an AES-256-GCM
 * envelope bound to the user id, under a KMS-wrapped DEK. Reads are dual for one
 * release: ciphertext first, then the Vault reference, then legacy plaintext.
 * With neither a cipher nor the Vault, a write REFUSES unless
 * OPENCLAW_ALLOW_PLAINTEXT_TOKENS=1 (dev only), so a database without Vault
 * (Cloud SQL) can never silently receive plaintext tokens.
 */

import type postgres from "postgres";
import { legacyReadsAllowed, TokenCipherError, type TokenCipher } from "./token-cipher.js";
import type { SyntropyVault } from "./vault.js";
import { secretNameForUser } from "./vault.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function ensureSyntropySchema(sql: postgres.Sql): Promise<void> {
  // `auth_token` is left nullable for legacy rows during the migration window.
  // New writes (post-PR #12) write `vault_secret_name` and leave auth_token NULL.
  await sql`
    CREATE TABLE IF NOT EXISTS syntropy_tokens (
      user_id            UUID NOT NULL REFERENCES lp_users(id) ON DELETE CASCADE,
      auth_token         TEXT,
      vault_secret_name  TEXT,
      origin             VARCHAR(50) NOT NULL DEFAULT 'pairing',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id)
    )
  `;
  // Idempotent: on existing deployments, drop the NOT NULL constraint and
  // add the new column. CREATE TABLE IF NOT EXISTS above is a no-op there.
  await sql`ALTER TABLE syntropy_tokens ALTER COLUMN auth_token DROP NOT NULL`;
  await sql`ALTER TABLE syntropy_tokens ADD COLUMN IF NOT EXISTS vault_secret_name TEXT`;
  await sql`ALTER TABLE syntropy_tokens ADD COLUMN IF NOT EXISTS token_ciphertext TEXT`;
}

/** Thrown when no protected store is available and plaintext is not explicitly allowed. */
export class PlaintextTokenRefusedError extends Error {
  constructor() {
    super(
      "syntropy token store: no cipher and no Vault configured; refusing to store a plaintext token " +
        "(set OPENCLAW_TOKEN_KEK_NAME + OPENCLAW_TOKEN_DEK_WRAPPED, or OPENCLAW_ALLOW_PLAINTEXT_TOKENS=1 for local dev)",
    );
    this.name = "PlaintextTokenRefusedError";
  }
}

function plaintextAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.OPENCLAW_ALLOW_PLAINTEXT_TOKENS ?? "").trim() === "1";
}

/** A stored row's token fields, as selected from `syntropy_tokens`. */
export type StoredTokenRow = {
  token_ciphertext?: string | null;
  vault_secret_name?: string | null;
  auth_token?: string | null;
};

/**
 * Resolve a stored row to its plaintext token. Order: ciphertext, then Vault,
 * then legacy plaintext. A ciphertext that cannot be opened (tamper, wrong or
 * rotated key, no cipher loaded) THROWS a named error: it never falls through to
 * an older copy and never reads as "not paired".
 */
export type TokenSource = "cipher" | "vault" | "legacy";

export async function readStoredTokenWithSource(
  row: StoredTokenRow,
  userId: string,
  vault: SyntropyVault | null,
  cipher: TokenCipher | null,
): Promise<{ token: string; source: TokenSource } | null> {
  if (row.token_ciphertext) {
    if (!cipher) throw new TokenCipherError("no_cipher");
    return { token: cipher.open(userId, row.token_ciphertext), source: "cipher" };
  }
  const hasLegacy = Boolean(row.vault_secret_name || row.auth_token);
  // Once every row is ciphertext, unencrypted rows are refused: a DB writer cannot
  // downgrade a user by clearing the ciphertext and planting a token in an old column.
  if (hasLegacy && cipher && !legacyReadsAllowed()) {
    throw new TokenCipherError("legacy_read_disabled");
  }
  if (row.vault_secret_name && vault) {
    const token = await vault.get(row.vault_secret_name);
    return token ? { token, source: "vault" } : null;
  }
  if (row.vault_secret_name && !row.auth_token) {
    // A Vault reference with no Vault and no legacy copy (e.g. after the Cloud SQL move) is a
    // named failure, not a silent "not paired". A transition-era row that still carries a
    // legacy copy keeps its old dev-mode behaviour and reads that copy.
    throw new TokenCipherError("vault_unavailable");
  }
  return row.auth_token ? { token: row.auth_token, source: "legacy" } : null;
}

export async function readStoredToken(
  row: StoredTokenRow,
  userId: string,
  vault: SyntropyVault | null,
  cipher: TokenCipher | null,
): Promise<string | null> {
  return (await readStoredTokenWithSource(row, userId, vault, cipher))?.token ?? null;
}

/**
 * Re-encrypt an unencrypted (Vault / legacy) token in place the first time it is read
 * with a cipher loaded. This migrates rows lazily and shrinks the dual-read window.
 * Best-effort: callers log a failure and keep the token they already read.
 */
export async function migrateTokenToCipher(
  sql: postgres.Sql,
  userId: string,
  token: string,
  cipher: TokenCipher,
): Promise<void> {
  const envelope = cipher.seal(userId, token);
  await sql`
    UPDATE syntropy_tokens
    SET token_ciphertext = ${envelope}, vault_secret_name = NULL, auth_token = NULL, updated_at = now()
    WHERE user_id = ${userId}
  `;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Store (or replace) the Syntropy auth token for a user.
 *
 * Behaviour:
 *   - If `vault` is provided (production path): writes the plaintext to
 *     Supabase Vault under `syntropy_user_<userId>` and stores ONLY the
 *     vault secret name in Postgres. The plaintext never touches our DB.
 *   - If `vault` is null (dev fallback): writes the plaintext to the
 *     legacy `auth_token` column. Used when SUPABASE_* env vars are
 *     absent in local development.
 *
 * @param sql        Postgres client
 * @param vault      Optional Supabase Vault client. Null → legacy plaintext path.
 * @param userId     OpenClaw internal UUID (`lp_users.id`)
 * @param authToken  The full `sj_<short>_<long>` token string
 * @param origin     How the token was obtained (`"pairing"` or `"manual"`)
 */
export async function upsertSyntropyToken(
  sql: postgres.Sql,
  vault: SyntropyVault | null,
  userId: string,
  authToken: string,
  origin = "pairing",
  cipher: TokenCipher | null = null,
): Promise<void> {
  if (cipher) {
    const envelope = cipher.seal(userId, authToken);
    await sql`
      INSERT INTO syntropy_tokens (user_id, token_ciphertext, vault_secret_name, auth_token, origin)
      VALUES (${userId}, ${envelope}, NULL, NULL, ${origin})
      ON CONFLICT (user_id) DO UPDATE
        SET token_ciphertext  = EXCLUDED.token_ciphertext,
            vault_secret_name = NULL,
            auth_token        = NULL,
            origin            = EXCLUDED.origin,
            updated_at        = now()
    `;
    return;
  }
  if (vault) {
    const name = secretNameForUser(userId);
    await vault.set(name, authToken);
    await sql`
      INSERT INTO syntropy_tokens (user_id, vault_secret_name, auth_token, origin)
      VALUES (${userId}, ${name}, NULL, ${origin})
      ON CONFLICT (user_id) DO UPDATE
        SET vault_secret_name = EXCLUDED.vault_secret_name,
            auth_token        = NULL,
            token_ciphertext  = NULL,
            origin            = EXCLUDED.origin,
            updated_at        = now()
    `;
    return;
  }

  // Legacy path: dev only, and only with an explicit opt-in.
  if (!plaintextAllowed()) {
    throw new PlaintextTokenRefusedError();
  }
  await sql`
    INSERT INTO syntropy_tokens (user_id, auth_token, origin)
    VALUES (${userId}, ${authToken}, ${origin})
    ON CONFLICT (user_id) DO UPDATE
      SET auth_token       = EXCLUDED.auth_token,
          token_ciphertext = NULL,
          origin           = EXCLUDED.origin,
          updated_at       = now()
  `;
}

/**
 * Retrieve the stored Syntropy auth token for a user.
 *
 * Reads `vault_secret_name` first (post-migration rows) and falls back to
 * the legacy plaintext `auth_token` column (pre-migration rows). Logs
 * which path was used so ops can monitor backfill progress.
 *
 * @param sql    Postgres client
 * @param vault  Optional Supabase Vault client. Required for new rows; null
 *               makes us strictly-legacy (dev only).
 * @param userId OpenClaw internal UUID (`lp_users.id`)
 * @returns      The token string, or `null` if not stored.
 */
export async function getSyntropyToken(
  sql: postgres.Sql,
  vault: SyntropyVault | null,
  userId: string,
  cipher: TokenCipher | null = null,
): Promise<string | null> {
  const rows = await sql`
    SELECT auth_token, vault_secret_name, token_ciphertext
    FROM syntropy_tokens
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return readStoredToken(row as StoredTokenRow, userId, vault, cipher);
}
