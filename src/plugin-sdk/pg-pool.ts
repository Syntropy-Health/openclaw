/**
 * Opening PostgreSQL pools from plugins — ONE shared pool per database URL.
 *
 * Plugins open their pool through `openPluginPool` rather than calling the
 * driver directly. Every call for the same URL in this process gets a handle on
 * the SAME underlying pool, so the connections a gateway process can hold are
 * bounded by one number — the pool's `max` — no matter how many plugins, loops
 * or wrappers call it. (Per-plugin pools made the total "plugins x max", and
 * counting plugins from source proved unreliable.)
 *
 * - `max` comes from `OPENCLAW_PG_POOL_MAX` (integer 1..PG_POOL_MAX_CEILING),
 *   default 5. An invalid or over-ceiling value falls back to the default and is
 *   REPORTED through the plugin's logger — never silently ignored. It never
 *   throws: a throw in `register()` disables the plugin, which for a fail-closed
 *   gate is a fail-OPEN.
 * - `idle_timeout` returns idle connections to the server; `connect_timeout` is
 *   shorter than the driver default so a dead database fails fast instead of
 *   stalling every queued query.
 * - Each handle's `end()` releases only that caller's reference; the pool itself
 *   closes when the last holder ends. One plugin shutting down cannot close the
 *   pool under another.
 *
 * Sharing is safe because callers issue independent single statements: no
 * transactions, reserved connections, LISTEN or session state hold a connection
 * (verified 2026-09-29 across every caller). A caller that needs those must not
 * use the shared pool.
 *
 * The driver is passed in (`factory`) so the SDK carries no database dependency.
 */
export const PG_POOL_MAX_ENV = "OPENCLAW_PG_POOL_MAX";
export const DEFAULT_PG_POOL_MAX = 5;
/**
 * Highest accepted override. Deployment-derived: the database role for openclaw
 * has CONNECTION LIMIT 20, two gateway processes can overlap during a deploy, and
 * 2 are reserved for operators — so 2 x 9 = 18. Pinned by
 * pg-pool.enumeration.test.ts; raise it only with that arithmetic.
 */
export const PG_POOL_MAX_CEILING = 9;
/** Seconds an idle pooled connection is kept before being closed. */
export const PG_POOL_IDLE_TIMEOUT_S = 30;
/** Seconds to wait when opening a connection (driver default is 30). */
export const PG_POOL_CONNECT_TIMEOUT_S = 10;
const MIN = 1;

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
  if (!Number.isInteger(n) || n < MIN || n > PG_POOL_MAX_CEILING) {
    return {
      max: DEFAULT_PG_POOL_MAX,
      invalid: `${PG_POOL_MAX_ENV}=${JSON.stringify(raw)} is not an integer in [${MIN}, ${PG_POOL_MAX_CEILING}]; using ${DEFAULT_PG_POOL_MAX}`,
    };
  }
  return { max: n };
}

export type PgPoolOptions = { max: number; idle_timeout: number; connect_timeout: number };
export type PgPoolFactory<T> = (url: string, options: PgPoolOptions) => T;
type Endable = { end: (...args: never[]) => Promise<unknown> };

const shared = new Map<string, { pool: Endable; refs: number }>();

/**
 * Open (or join) the process-wide pool for `url`:
 * `openPluginPool(postgres, url, { logger, plugin })`. Returns a handle that
 * behaves exactly like the pool except that `end()` releases only this caller.
 */
export function openPluginPool<T extends Endable>(
  factory: PgPoolFactory<T>,
  url: string,
  ctx: { logger: { warn: (message: string) => void }; plugin: string },
  env: Record<string, string | undefined> = process.env,
): T {
  const resolved = resolvePgPoolMax(env);
  if (resolved.invalid) {
    ctx.logger.warn(`${ctx.plugin}: ${resolved.invalid}`);
  }
  let entry = shared.get(url);
  if (!entry) {
    entry = {
      pool: factory(url, {
        max: resolved.max,
        idle_timeout: PG_POOL_IDLE_TIMEOUT_S,
        connect_timeout: PG_POOL_CONNECT_TIMEOUT_S,
      }),
      refs: 0,
    };
    shared.set(url, entry);
  }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return new Proxy(held.pool as T, {
    get(target, prop, receiver) {
      if (prop === "end") {
        return async (...args: never[]) => {
          if (released) {
            return;
          }
          released = true;
          held.refs -= 1;
          if (held.refs > 0) {
            return;
          }
          if (shared.get(url) === held) {
            shared.delete(url);
          }
          return target.end(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Diagnostic view: holder count per open shared pool. Deliberately carries NO
 * url — connection strings contain credentials, and this is the kind of value a
 * readiness endpoint would be tempted to surface.
 */
export function sharedPgPoolHolders(): number[] {
  return [...shared.values()].map((e) => e.refs);
}
