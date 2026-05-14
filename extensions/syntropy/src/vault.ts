/**
 * SyntropyVault — thin wrapper around Supabase Vault for storing
 * `sj_*` Bearer credentials at rest.
 *
 * Rationale (PR #9 review follow-up, Item 1):
 *
 *   Previously `syntropy_tokens.auth_token` was a plaintext TEXT column,
 *   protected only by infrastructure encryption-at-rest. For a healthcare
 *   product that's not enough — column-level encryption is table stakes.
 *
 *   Rather than build our own pgcrypto layer, we lean on Supabase Vault
 *   (`pgsodium`-backed) which runs natively in the Supabase Postgres that
 *   openclaw and SJ already share. Keys are managed by Supabase, we never
 *   see them, and audit logs are free.
 *
 * Connection mechanism (revised in this commit):
 *
 *   The previous implementation called Supabase Vault via the JS SDK and a
 *   separate `SUPABASE_SERVICE_ROLE_KEY` env var. Investigation revealed
 *   that openclaw's existing `DATABASE_URL` already points at the same
 *   Supabase Postgres as SJ (project `vouzkcwwkpqsgiquemwp`) — meaning we
 *   can invoke the Vault RPCs as plain SQL functions through the same
 *   `postgres` client we already use for `lp_users` and `syntropy_tokens`.
 *
 *   This removes the `@supabase/supabase-js` dependency, drops the
 *   separate config fields, and reduces the production attack surface
 *   (one connection, not two).
 *
 * RPC contract — three SECURITY DEFINER functions on the Postgres side:
 *
 *   app_syntropy_token_set(p_name text, p_plaintext text) returns void
 *   app_syntropy_token_get(p_name text) returns text  -- null if missing
 *   app_syntropy_token_delete(p_name text) returns void
 *
 * The SECURITY DEFINER scoping ensures that even though openclaw's DB
 * user has direct connection access, it can only read/write secrets
 * under the `syntropy_user_*` namespace (enforced by
 * `app_syntropy_validate_name`).
 *
 * The SQL migration is checked in at
 * `extensions/syntropy/supabase-migrations/0001_syntropy_vault_rpcs.sql`.
 *
 * Tests in `vault.test.ts` use an injected `SqlExecutor` mock so we don't
 * need a live Supabase project.
 */

import type postgres from "postgres";

// ---------------------------------------------------------------------------
// Narrow dependency surface — only what we actually call
// ---------------------------------------------------------------------------

/**
 * Minimal SQL primitive injected into the vault wrapper for testability.
 * Production usage passes the project-wide `postgres` client; tests inject
 * a mock that records calls.
 */
export interface SqlExecutor {
  /** Execute `SELECT fn(arg1, arg2)` and return the scalar value. */
  callScalar<T>(fnName: string, args: readonly unknown[]): Promise<T | null>;
  /** Execute `SELECT fn(arg1, arg2)` and discard the result. */
  callVoid(fnName: string, args: readonly unknown[]): Promise<void>;
}

/** Stable deterministic name for a user's syntropy token in the vault. */
export function secretNameForUser(userId: string): string {
  if (!userId) throw new Error("secretNameForUser: userId is required");
  return `syntropy_user_${userId}`;
}

// ---------------------------------------------------------------------------
// Vault wrapper
// ---------------------------------------------------------------------------

export class SyntropyVault {
  constructor(private readonly sql: SqlExecutor) {}

  async set(name: string, plaintext: string): Promise<void> {
    if (!name) throw new Error("SyntropyVault.set: name is required");
    if (!plaintext) throw new Error("SyntropyVault.set: plaintext is required");
    await this.sql.callVoid("app_syntropy_token_set", [name, plaintext]);
  }

  async get(name: string): Promise<string | null> {
    if (!name) throw new Error("SyntropyVault.get: name is required");
    const result = await this.sql.callScalar<string>("app_syntropy_token_get", [name]);
    return result ?? null;
  }

  async delete(name: string): Promise<void> {
    if (!name) throw new Error("SyntropyVault.delete: name is required");
    await this.sql.callVoid("app_syntropy_token_delete", [name]);
  }
}

// ---------------------------------------------------------------------------
// Production factory — wires the wrapper to the existing postgres client
// ---------------------------------------------------------------------------

/**
 * Probe whether the SECURITY DEFINER vault RPCs are installed in the
 * current database. Used at plugin startup to decide whether to enable
 * the vault path or fall back to the legacy plaintext `auth_token`
 * column.
 *
 * The probe is one round-trip and tolerates a missing function gracefully
 * (returns false rather than throwing).
 */
export async function vaultRpcsInstalled(sql: postgres.Sql): Promise<boolean> {
  try {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'app_syntropy_token_set'
      ) AS exists
    `;
    return rows[0]?.exists ?? false;
  } catch {
    return false;
  }
}

/**
 * Build a SyntropyVault backed by the existing `postgres` Sql client.
 * No new connection, no Supabase JS SDK, no service-role key — the
 * client already authenticated to the shared Supabase Postgres at
 * registration time.
 */
export function createSyntropyVault(sql: postgres.Sql): SyntropyVault {
  const executor: SqlExecutor = {
    async callScalar<T>(fnName: string, args: readonly unknown[]): Promise<T | null> {
      // `postgres` template-literal tagging defends against SQL injection
      // even though we identify the function by name. Args bind via $1, $2.
      const rows = await sql.unsafe(
        `SELECT ${fnName}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS result`,
        args as (string | null)[],
      );
      const value = rows[0]?.result;
      return (value ?? null) as T | null;
    },
    async callVoid(fnName: string, args: readonly unknown[]): Promise<void> {
      await sql.unsafe(
        `SELECT ${fnName}(${args.map((_, i) => `$${i + 1}`).join(", ")})`,
        args as (string | null)[],
      );
    },
  };
  return new SyntropyVault(executor);
}
