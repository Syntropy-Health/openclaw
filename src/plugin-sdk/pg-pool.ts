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

export type PgPoolOptions = {
  max: number;
  idle_timeout: number;
  connect_timeout: number;
  /** Called for each server NOTICE (see createPgNoticeHandler). */
  onnotice?: (notice: unknown) => void;
};

/**
 * "Already exists, skipping" notices from CREATE/ADD ... IF NOT EXISTS on objects
 * that already exist: duplicate schema (42P06), table (42P07), column (42701) or
 * object (42710).
 * They fire on every boot and carry no information.
 */
const ROUTINE_NOTICE_CODES: ReadonlySet<string> = new Set(["42P06", "42P07", "42701", "42710"]);
const ROUTINE_NOTICE_TEXT = /already exists, skipping$/;
const NOTICE_LINE_MAX = 200;

/**
 * Server NOTICE handler for plugin pools. The driver's default prints each notice
 * as a multi-line object, so routine schema notices at boot flood the log and push
 * the boot's own lines out of view. Routine "already exists, skipping" NOTICEs are
 * dropped; anything else (another code, or a higher severity) becomes one bounded,
 * single-line warning: `postgres <SEVERITY> <code> (pool opened by <plugin>): <message>`.
 * Never throws. The pool is shared per URL, so the notice may come from any plugin
 * using it; the label names only the plugin that opened the pool.
 */
export function createPgNoticeHandler(ctx: {
  logger: { warn: (message: string) => void };
  plugin: string;
}): (notice: unknown) => void {
  return (notice) => {
    const o =
      notice && typeof notice === "object" ? (notice as Record<string, unknown>) : undefined;
    const severity = typeof o?.severity === "string" ? o.severity : "NOTICE";
    const code = typeof o?.code === "string" ? o.code : "?";
    const message =
      typeof o?.message === "string" ? o.message : typeof notice === "string" ? notice : "";
    if (
      severity === "NOTICE" &&
      ROUTINE_NOTICE_CODES.has(code) &&
      ROUTINE_NOTICE_TEXT.test(message)
    ) {
      return;
    }
    const flat = message.replace(/\s+/g, " ").trim().slice(0, NOTICE_LINE_MAX);
    try {
      ctx.logger.warn(`postgres ${severity} ${code} (pool opened by ${ctx.plugin}): ${flat}`);
    } catch {
      // a logger failure must never break a query
    }
  };
}
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
        onnotice: createPgNoticeHandler(ctx),
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

/**
 * Postgres error codes for "already exists" when two sessions create the same
 * object at the same moment: a unique violation on the catalog (23505), a
 * duplicate table (42P07) or a duplicate object such as an index (42710).
 */
export const DDL_RACE_CODES: readonly string[] = Object.freeze(["23505", "42P07", "42710"]);

const DDL_RACE_ATTEMPTS = 5;

/**
 * Run one schema statement (CREATE ... IF NOT EXISTS), retrying ONLY when a
 * concurrent session created the same object first. `IF NOT EXISTS` does not cover
 * that case, so concurrent first boots (several gateways, or parallel test suites)
 * on a fresh database can fail without it. At most 5 attempts with a short, growing
 * backoff; any other error is thrown at once. The happy path runs once.
 */
export async function retryDdlRace<T>(
  run: () => Promise<T>,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (
        attempt >= DDL_RACE_ATTEMPTS ||
        typeof code !== "string" ||
        !DDL_RACE_CODES.includes(code)
      ) {
        throw err;
      }
      await sleep(20 * attempt);
    }
  }
}
