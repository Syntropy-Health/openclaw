import type { GroupLock } from "../forget.js";
import type { RegenerateOutcome } from "./regenerate.js";
import type { HighlightStore } from "./store.js";

export type SchedulerOptions = {
  store: Pick<HighlightStore, "staleDue" | "nightlyDue" | "claimOnDemand">;
  /** The per-group lock shared with capture and forget. */
  lock: GroupLock;
  regenerate: (groupId: string) => Promise<RegenerateOutcome>;
  logger: { info: (m: string) => void; warn: (m: string) => void };
  now: () => Date;
  /** Expired recall rows, swept each tick (writes also sweep; this covers quiet periods). */
  sweep?: () => Promise<unknown>;
  intervalMs?: number;
  debounceSec?: number;
  dailyCap?: number;
  nightlyHourUtc?: number;
  /** Most groups one tick regenerates per pass. */
  batch?: number;
};

export type HighlightScheduler = {
  start(): void;
  stop(): Promise<void>;
  /** One pass now (the timer calls this). Never throws. */
  tick(): Promise<void>;
  /** A first read with no highlights: take an on-demand slot and regenerate now. */
  requestNow(groupId: string): Promise<boolean>;
};

/**
 * Freshness worker (A&D §4.4): every minute, regenerate groups stale for at least
 * the debounce and under today's on-demand cap; in the nightly hour (03:00 UTC),
 * once per day, every stale group whatever its count. Runs are serial and take
 * the per-group lock. Logs counts only.
 */
export function createHighlightScheduler(opts: SchedulerOptions): HighlightScheduler {
  const intervalMs = opts.intervalMs ?? 60_000;
  const debounceSec = opts.debounceSec ?? 120;
  const cap = opts.dailyCap ?? 3;
  const nightlyHour = opts.nightlyHourUtc ?? 3;
  const batch = opts.batch ?? 50;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let lastNightlyDay: string | null = null;
  const background = new Set<Promise<unknown>>();

  const run = async (groupId: string): Promise<boolean> => {
    try {
      await opts.lock([groupId], () => opts.regenerate(groupId));
      return true;
    } catch {
      opts.logger.warn("memory-highlights: a regeneration failed");
      return false;
    }
  };

  const pass = async () => {
    let regenerated = 0;
    const now = opts.now();
    const day = now.toISOString().slice(0, 10);
    try {
      if (now.getUTCHours() === nightlyHour && lastNightlyDay !== day) {
        lastNightlyDay = day;
        for (const g of await opts.store.nightlyDue(batch * 20)) {
          regenerated += (await run(g)) ? 1 : 0;
        }
      }
      for (const g of await opts.store.staleDue({ debounceSec, cap, limit: batch })) {
        if (await opts.store.claimOnDemand(g, cap)) {
          regenerated += (await run(g)) ? 1 : 0;
        }
      }
    } catch {
      opts.logger.warn("memory-highlights: scheduler pass failed");
    }
    if (opts.sweep) {
      try {
        await opts.sweep();
      } catch {
        opts.logger.warn("memory-highlights: recall sweep failed");
      }
    }
    if (regenerated > 0) {
      opts.logger.info(`memory-highlights: regenerated groups=${regenerated}`);
    }
  };

  const tick = async () => {
    if (running) {
      return;
    }
    running = pass().finally(() => {
      running = null;
    });
    await running;
  };

  return {
    start() {
      if (timer) {
        return;
      }
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await running;
      await Promise.allSettled([...background]);
    },
    tick,
    async requestNow(groupId) {
      if (!(await opts.store.claimOnDemand(groupId, cap))) {
        return false;
      }
      const p = run(groupId).finally(() => background.delete(p));
      background.add(p);
      return true;
    },
  };
}
