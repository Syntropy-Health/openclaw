/**
 * Opening PostgreSQL pools from plugins.
 *
 * Plugins that talk to Postgres open their pool through `openPluginPool` rather
 * than calling the driver directly, so pool sizing is decided in one place:
 *
 * - `max` comes from `OPENCLAW_PG_POOL_MAX` (integer 1..100), default 1.
 * - `idle_timeout` returns idle connections to the server, so a process that is
 *   not busy does not hold its full allowance (important when two processes
 *   overlap during a deploy against a connection-capped database role).
 * - An invalid override falls back to the default and is REPORTED through the
 *   plugin's logger — never silently ignored, because a silently-ignored
 *   override reads as applied. It never throws: a throw in `register()` would
 *   disable the plugin, which for a fail-closed gate is a fail-OPEN.
 *
 * Note: the override applies to EVERY plugin pool in the process, so the real
 * total is (number of plugin pools) x max. The deployment's budget for that
 * product is enforced by `pg-pool.enumeration.test.ts`, not here — this module
 * stays deployment-agnostic.
 *
 * The driver is passed in (`factory`) so the SDK carries no database dependency.
 */
export const PG_POOL_MAX_ENV = "OPENCLAW_PG_POOL_MAX";
export const DEFAULT_PG_POOL_MAX = 1;
/** Seconds an idle pooled connection is kept before being closed. */
export const PG_POOL_IDLE_TIMEOUT_S = 30;
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

export type PgPoolOptions = { max: number; idle_timeout: number };
export type PgPoolFactory<T> = (url: string, options: PgPoolOptions) => T;

/**
 * Open a plugin's Postgres pool with the process-wide sizing policy. Use this
 * instead of calling the driver: `openPluginPool(postgres, url, { logger, plugin })`.
 */
export function openPluginPool<T>(
  factory: PgPoolFactory<T>,
  url: string,
  ctx: { logger: { warn: (message: string) => void }; plugin: string },
  env: Record<string, string | undefined> = process.env,
): T {
  const resolved = resolvePgPoolMax(env);
  if (resolved.invalid) {
    ctx.logger.warn(`${ctx.plugin}: ${resolved.invalid}`);
  }
  return factory(url, { max: resolved.max, idle_timeout: PG_POOL_IDLE_TIMEOUT_S });
}
