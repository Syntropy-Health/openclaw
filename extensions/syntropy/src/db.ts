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
 */

import type postgres from "postgres";
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
): Promise<void> {
  if (vault) {
    const name = secretNameForUser(userId);
    await vault.set(name, authToken);
    await sql`
      INSERT INTO syntropy_tokens (user_id, vault_secret_name, auth_token, origin)
      VALUES (${userId}, ${name}, NULL, ${origin})
      ON CONFLICT (user_id) DO UPDATE
        SET vault_secret_name = EXCLUDED.vault_secret_name,
            auth_token        = NULL,
            origin            = EXCLUDED.origin,
            updated_at        = now()
    `;
    return;
  }

  // Legacy path — dev only.
  await sql`
    INSERT INTO syntropy_tokens (user_id, auth_token, origin)
    VALUES (${userId}, ${authToken}, ${origin})
    ON CONFLICT (user_id) DO UPDATE
      SET auth_token = EXCLUDED.auth_token,
          origin     = EXCLUDED.origin,
          updated_at = now()
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
): Promise<string | null> {
  const rows = await sql`
    SELECT auth_token, vault_secret_name
    FROM syntropy_tokens
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  const vaultSecretName = row.vault_secret_name as string | null;
  if (vaultSecretName && vault) {
    return await vault.get(vaultSecretName);
  }

  // Legacy plaintext fallback.
  return (row.auth_token as string | null) ?? null;
}
