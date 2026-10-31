/**
 * Wrap every method of a store so it first awaits `ready()` (the plugin's
 * lp_memory_* schema, created once on first use). Replaces one hand-written
 * `async (...) => (await ready(), store.method(...))` line per method, so a method
 * added to a store cannot be left unguarded by forgetting its wrapper line.
 *
 * The target must be a plain object literal whose every own property is a method
 * (anything else throws, so a class instance's prototype methods cannot be silently
 * dropped); each is called on the original object, so `this` is unchanged. If
 * `ready()` rejects, the method is not called and the call rejects with that error.
 */
type AsyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R>
    : never;
};

export function afterReady<T extends AsyncMethods<T>>(target: T, ready: () => Promise<unknown>): T {
  if (Object.getPrototypeOf(target) !== Object.prototype) {
    throw new TypeError("afterReady: target must be a plain object literal");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(target)) {
    if (typeof value !== "function") {
      throw new TypeError(`afterReady: ${key} is not a method`);
    }
    out[key] = async (...args: unknown[]) => {
      await ready();
      return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
    };
  }
  return out as T;
}
