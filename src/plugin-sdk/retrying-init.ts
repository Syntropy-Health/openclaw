/**
 * Lazy one-time initialisation (connect + schema) that RETRIES after failure.
 *
 * Plugins used to cache the first init error for the life of the process
 * ("init failed (will not retry)"), so a transient failure at boot — a database
 * briefly unreachable, a role at its connection limit — disabled the plugin
 * until someone restarted the gateway. This wrapper instead remembers a failure
 * only for a backoff window (1s, 2s, 4s … capped at 60s):
 *
 * - inside the window the last error is rethrown without a new attempt, so a
 *   burst of calls cannot become a connection storm;
 * - after it, the next call makes exactly one attempt, shared by concurrent
 *   callers;
 * - once an attempt succeeds, init never runs again.
 *
 * Only errors that REACH this wrapper are retried: an init that catches its own
 * failure and returns normally has, from here, succeeded.
 */
export type RetryingInitOptions = {
  logger: { error: (message: string) => void; info: (message: string) => void };
  plugin: string;
  /** Clock, injectable for tests. */
  now?: () => number;
};

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export function createRetryingInit(
  init: () => Promise<void>,
  opts: RetryingInitOptions,
): () => Promise<void> {
  const now = opts.now ?? Date.now;
  let ready = false;
  let failures = 0;
  let lastError: { error: unknown } | null = null;
  let nextAttemptAt = 0;
  let inFlight: Promise<void> | null = null;

  return async function ensure(): Promise<void> {
    if (ready) {
      return;
    }
    if (lastError && now() < nextAttemptAt) {
      throw lastError.error;
    }
    inFlight ??= (async () => {
      try {
        // Via a resolved promise so an init that throws SYNCHRONOUSLY becomes a
        // rejection here. Calling init() directly let a sync throw run this whole
        // body — finally included — before `inFlight` was assigned, leaving a
        // rejected promise stored forever: the "cached forever" defect again.
        await Promise.resolve().then(init);
        ready = true;
        failures = 0;
        lastError = null;
      } catch (err) {
        failures += 1;
        const delayMs = Math.min(BASE_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
        // Boxed so a falsy thrown value (e.g. `throw undefined`) still opens a window.
        lastError = { error: err ?? new Error(`${opts.plugin}: init failed`) };
        nextAttemptAt = now() + delayMs;
        opts.logger.error(
          `${opts.plugin}: init failed (attempt ${failures}, retry in ${delayMs / 1000}s): ${String(err)}`,
        );
        throw lastError.error;
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };
}
