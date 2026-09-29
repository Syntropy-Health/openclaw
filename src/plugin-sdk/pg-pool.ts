/**
 * Per-pool PostgreSQL size for EVERY plugin pool opened against DATABASE_URL.
 *
 * Budget: openclaw's database lives in a dedicated schema of a shared Supabase
 * project, and its role `openclaw_app` has CONNECTION LIMIT 20 (devex,
 * 2026-09-28) so openclaw can never starve the co-tenant. Pool INSTANCES
 * enumerated 2026-09-28: auth-memory-gate, memory-graphiti (identity strategy),
 * syntropy (direct `postgres()`), persist-postgres, persist-user-identity, twilio
 * and kapso (via the createPgClient / createSmsPgClient factories — kapso reuses
 * twilio's). Seven x 2 = 14, leaving 6 of 20 for operator sessions and growth.
 * The previous hardcoded sizes (10+10+10+5+5+3+3 = 46) exceeded the limit.
 *
 * The enumeration and the arithmetic are ENFORCED by pg-pool.enumeration.test.ts
 * (a new pool, a hardcoded max, or a default that breaks the budget fails it) —
 * this comment explains the numbers; the test is what keeps them true.
 * postgres.js QUEUES queries beyond `max`, so a small pool degrades to latency,
 * not errors, at this traffic level.
 *
 * An invalid override falls back to the default and is REPORTED (`invalid`), not
 * swallowed: a silently-ignored override reads as applied. It deliberately does
 * not throw — a throw in register() would disable the plugin, and for
 * auth-memory-gate with hardGate that is a fail-OPEN.
 */
export const PG_POOL_MAX_ENV = "OPENCLAW_PG_POOL_MAX";
export const DEFAULT_PG_POOL_MAX = 2;
const MIN = 1;
const MAX = 100;

export type PgPoolMaxResolution = { max: number; invalid?: string };

export function resolvePgPoolMax(
  env: Record<string, string | undefined> = process.env,
): PgPoolMaxResolution {
  const raw = env[PG_POOL_MAX_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { max: DEFAULT_PG_POOL_MAX };
  }
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(n) || n < MIN || n > MAX) {
    return {
      max: DEFAULT_PG_POOL_MAX,
      invalid: `${PG_POOL_MAX_ENV}=${JSON.stringify(raw)} is not an integer in [${MIN}, ${MAX}]; using ${DEFAULT_PG_POOL_MAX}`,
    };
  }
  return { max: n };
}
