/**
 * Per-user single-flight + cooldown for expensive per-account routes (forget,
 * highlight remove): one valid account must not be able to loop a costly operation
 * against the shared event loop. Per instance, in memory.
 *
 * `refusal(sub)` says whether a call may start now; `run(sub, fn)` runs it, holding
 * the user's slot for the duration and starting the cooldown when it ends, whether
 * `fn` resolved or threw.
 */
export type PerUserGateRefusal = "in_progress" | "rate_limited";

export type PerUserGate = {
  /** Why `sub` may not start a call now, or null when it may. */
  refusal(sub: string): PerUserGateRefusal | null;
  /** Run `fn` as `sub`'s one call in flight; the cooldown starts when it settles. */
  run<T>(sub: string, fn: () => Promise<T>): Promise<T>;
};

export function createPerUserGate(
  opts: { cooldownMs?: number; now?: () => number } = {},
): PerUserGate {
  const running = new Set<string>();
  const lastDone = new Map<string, number>();
  const cooldown = opts.cooldownMs ?? 5_000;
  const now = opts.now ?? Date.now;
  return {
    refusal(sub) {
      if (running.has(sub)) {
        return "in_progress";
      }
      const last = lastDone.get(sub);
      if (last !== undefined && now() - last < cooldown) {
        return "rate_limited";
      }
      return null;
    },
    async run(sub, fn) {
      running.add(sub);
      try {
        return await fn();
      } finally {
        running.delete(sub);
        lastDone.set(sub, now());
      }
    },
  };
}
