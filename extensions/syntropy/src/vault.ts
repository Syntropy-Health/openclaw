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
 *   (`pgsodium`-backed) running on the existing mobile Supabase project
 *   (`mmxvpogrdnblzgdeuhne.supabase.co`). Keys are managed by Supabase,
 *   we never see them, and audit logs are free.
 *
 * RPC contract — three SECURITY DEFINER functions on the Supabase side:
 *
 *   app_syntropy_token_set(p_name text, p_plaintext text) returns void
 *   app_syntropy_token_get(p_name text) returns text  -- null if missing
 *   app_syntropy_token_delete(p_name text) returns void
 *
 * The Supabase SQL migration is checked in alongside this file at
 * `extensions/syntropy/supabase-migrations/0001_syntropy_vault_rpcs.sql`.
 *
 * Tests in `vault.test.ts` use an injected `RpcCaller` mock so we don't
 * need a live Supabase project.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Narrow dependency surface — only what we actually call
// ---------------------------------------------------------------------------

/** Minimal RPC primitive injected into the vault wrapper for testability. */
export interface RpcCaller {
  call<T>(fn: string, args: Record<string, unknown>): Promise<T>;
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
  constructor(private readonly rpc: RpcCaller) {}

  async set(name: string, plaintext: string): Promise<void> {
    if (!name) throw new Error("SyntropyVault.set: name is required");
    if (!plaintext) throw new Error("SyntropyVault.set: plaintext is required");
    await this.rpc.call("app_syntropy_token_set", { p_name: name, p_plaintext: plaintext });
  }

  async get(name: string): Promise<string | null> {
    if (!name) throw new Error("SyntropyVault.get: name is required");
    const result = await this.rpc.call<string | null | undefined>("app_syntropy_token_get", {
      p_name: name,
    });
    return result ?? null;
  }

  async delete(name: string): Promise<void> {
    if (!name) throw new Error("SyntropyVault.delete: name is required");
    await this.rpc.call("app_syntropy_token_delete", { p_name: name });
  }
}

// ---------------------------------------------------------------------------
// Production factory — binds the wrapper to a real Supabase client
// ---------------------------------------------------------------------------

/**
 * Build a SyntropyVault backed by a real Supabase client. Service-role
 * key is required: the RPCs are SECURITY DEFINER and explicitly grant
 * EXECUTE only to `service_role`.
 *
 * @param url               Supabase project URL (e.g., https://*.supabase.co)
 * @param serviceRoleKey    Service-role JWT — KEEP SECRET, source via Infisical
 */
export function createSupabaseVault(url: string, serviceRoleKey: string): SyntropyVault {
  const client: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const rpc: RpcCaller = {
    async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(fn, args);
      if (error) {
        throw new Error(`SyntropyVault RPC ${fn} failed: ${error.message}`);
      }
      return data as T;
    },
  };
  return new SyntropyVault(rpc);
}
