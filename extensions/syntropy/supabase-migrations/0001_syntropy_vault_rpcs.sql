-- =========================================================================
-- Migration: 0001_syntropy_vault_rpcs
-- Target:    mobile Supabase project (mmxvpogrdnblzgdeuhne.supabase.co)
-- Owner:     openclaw extensions/syntropy
-- Purpose:   SECURITY DEFINER wrappers around Supabase Vault for openclaw's
--            `sj_*` Bearer-token storage. Called via the JS client's
--            `rpc()` method by the SyntropyVault TypeScript wrapper.
--
-- Why these wrappers exist:
--   - `vault.secrets` and `vault.decrypted_secrets` require elevated
--     privileges. Granting `service_role` direct access to the entire
--     vault schema is too broad — it would let other openclaw plugins
--     (or any service-role-keyed caller) read every secret.
--   - These RPCs scope access to *only* secrets whose name matches the
--     `syntropy_user_*` prefix, giving openclaw a narrow surface.
--
-- After applying this migration, the JS client can call:
--   client.rpc('app_syntropy_token_set',    { p_name, p_plaintext })
--   client.rpc('app_syntropy_token_get',    { p_name })            -- returns text|null
--   client.rpc('app_syntropy_token_delete', { p_name })
--
-- Rollback: see 0001_syntropy_vault_rpcs_rollback.sql (or simply DROP each
-- function below).
-- =========================================================================

-- Ensure the vault extension is enabled (no-op if already enabled).
create extension if not exists supabase_vault;

-- -------------------------------------------------------------------------
-- Helper: validate the name follows the openclaw namespacing convention.
-- Rejects attempts to read/write secrets outside the `syntropy_user_*` prefix.
-- -------------------------------------------------------------------------

create or replace function app_syntropy_validate_name(p_name text)
returns void
language plpgsql
immutable
as $$
begin
  if p_name is null or length(p_name) = 0 then
    raise exception 'app_syntropy: secret name is required'
      using errcode = '22023';
  end if;
  if p_name not like 'syntropy_user_%' then
    raise exception 'app_syntropy: secret name must start with `syntropy_user_`'
      using errcode = '22023';
  end if;
end;
$$;

-- -------------------------------------------------------------------------
-- SET — upsert a secret by name. If a secret with this name already exists,
-- update its plaintext in place (rotates the encrypted payload). Returns void.
-- -------------------------------------------------------------------------

create or replace function app_syntropy_token_set(p_name text, p_plaintext text)
returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_existing_id uuid;
begin
  perform app_syntropy_validate_name(p_name);

  if p_plaintext is null or length(p_plaintext) = 0 then
    raise exception 'app_syntropy: plaintext is required'
      using errcode = '22023';
  end if;

  select id into v_existing_id from vault.secrets where name = p_name limit 1;

  if v_existing_id is not null then
    perform vault.update_secret(v_existing_id, p_plaintext, p_name);
  else
    perform vault.create_secret(p_plaintext, p_name, 'openclaw syntropy token');
  end if;
end;
$$;

-- -------------------------------------------------------------------------
-- GET — decrypt and return the plaintext for a secret name, or NULL if it
-- doesn't exist. The decrypted_secrets view is owned by `supabase_admin`
-- and bypasses RLS, hence SECURITY DEFINER + a scoped query.
-- -------------------------------------------------------------------------

create or replace function app_syntropy_token_get(p_name text)
returns text
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_plaintext text;
begin
  perform app_syntropy_validate_name(p_name);
  select decrypted_secret into v_plaintext
  from vault.decrypted_secrets
  where name = p_name
  limit 1;
  return v_plaintext;  -- null if missing
end;
$$;

-- -------------------------------------------------------------------------
-- DELETE — remove a secret by name. No-op if missing.
-- -------------------------------------------------------------------------

create or replace function app_syntropy_token_delete(p_name text)
returns void
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
begin
  perform app_syntropy_validate_name(p_name);
  delete from vault.secrets where name = p_name;
end;
$$;

-- -------------------------------------------------------------------------
-- Grants — service_role can call these RPCs; nothing else can.
-- The functions themselves enforce the `syntropy_user_*` prefix gate.
-- -------------------------------------------------------------------------

revoke all on function app_syntropy_token_set(text, text)    from public;
revoke all on function app_syntropy_token_get(text)          from public;
revoke all on function app_syntropy_token_delete(text)       from public;
revoke all on function app_syntropy_validate_name(text)      from public;

grant execute on function app_syntropy_token_set(text, text) to service_role;
grant execute on function app_syntropy_token_get(text)       to service_role;
grant execute on function app_syntropy_token_delete(text)    to service_role;
