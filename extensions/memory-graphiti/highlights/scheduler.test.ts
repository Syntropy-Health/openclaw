/**
 * Freshness worker (A&D §4.4, PLAN P5.2), driven by fake timers: the 2-minute
 * debounce, the 3-per-day on-demand cap, the nightly 03:00 UTC run that ignores
 * the cap, runs serialised under the per-group lock, and the recall sweep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGroupLock } from "../lock.js";
import { FakeHighlightStore } from "../testing/fake-highlight-store.js";
import type { RegenerateOutcome } from "./regenerate.js";
import { createHighlightScheduler, type SchedulerOptions } from "./scheduler.js";

const MIN = 60_000;
const G = "ok_g";

function setup(over: Partial<SchedulerOptions> = {}) {
  const store = new FakeHighlightStore(() => new Date());
  const lock = createGroupLock();
  const ran: string[] = [];
  const regenerate = vi.fn(async (g: string): Promise<RegenerateOutcome> => {
    ran.push(g);
    // A real regeneration clears the stale mark via put.
    await store.put(g, { state: "ready", payload: [] }, await store.clock());
    return "ready";
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sweep = vi.fn(async () => undefined);
  const s = createHighlightScheduler({
    store,
    lock,
    regenerate,
    logger,
    sweep,
    now: () => new Date(),
    ...over,
  });
  return { store, lock, ran, regenerate, logger, sweep, s };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("highlight scheduler", () => {
  it("debounce: a group stale for under 2 minutes waits; at 2 minutes it regenerates", async () => {
    const { store, ran, s } = setup();
    await store.claimOnDemand(G, 3);
    await store.markStale(G);
    s.start();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(ran).toEqual([G]);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(ran).toEqual([G]); // the stale mark was cleared: no repeat
    await s.stop();
  });

  it("a fresh stale mark restarts the debounce (trailing)", async () => {
    const { store, ran, s } = setup();
    await store.claimOnDemand(G, 3);
    s.start();
    await store.markStale(G);
    await vi.advanceTimersByTimeAsync(1.5 * MIN);
    await store.markStale(G); // another turn at 1.5 min
    await vi.advanceTimersByTimeAsync(2 * MIN); // ticks at 2 and 3 min: under 2 min since the mark
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(0.5 * MIN); // tick at 4 min: 2.5 min since the mark
    expect(ran).toEqual([G]);
    await s.stop();
  });

  it("cap: at most 3 on-demand runs per UTC day (the first read counts); the rest wait", async () => {
    const { store, ran, s } = setup();
    expect(await s.requestNow(G)).toBe(true); // slot 1
    await vi.advanceTimersByTimeAsync(0);
    s.start();
    for (let i = 0; i < 4; i++) {
      await store.markStale(G);
      await vi.advanceTimersByTimeAsync(3 * MIN);
    }
    expect(ran).toHaveLength(3);
    expect(await s.requestNow(G)).toBe(false);
    // Still stale; waits for the nightly run (03:00 UTC tomorrow).
    expect((await store.get(G))?.staleSince).not.toBeNull();
    await s.stop();
  });

  it("nightly: at 03:00 UTC every stale group runs, cap or not, once per day", async () => {
    const { store, ran, s } = setup();
    vi.setSystemTime(new Date("2026-10-30T02:50:00Z"));
    await store.claimOnDemand(G, 3);
    await store.claimOnDemand(G, 3);
    await store.claimOnDemand(G, 3); // capped for 10-30
    await store.markStale(G);
    s.start();
    await vi.advanceTimersByTimeAsync(9 * MIN); // 02:59
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN); // 03:01
    expect(ran).toEqual([G]);
    await store.markStale(G);
    await vi.advanceTimersByTimeAsync(30 * MIN); // still the 03:00 hour, capped
    expect(ran).toEqual([G]);
    await s.stop();
  });

  it("runs under the per-group lock: a regeneration waits for a capture holding it", async () => {
    const { store, lock, ran, s } = setup();
    await store.claimOnDemand(G, 3);
    await store.markStale(G);
    let release!: () => void;
    const held = lock([G], () => new Promise<void>((r) => (release = r)));
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(ran).toEqual([]);
    release();
    await held;
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toEqual([G]);
    await s.stop();
  });

  it("ticks never overlap: a slow tick makes the next ones skip", async () => {
    let finish!: () => void;
    const regenerate = vi.fn(
      () => new Promise<RegenerateOutcome>((r) => (finish = () => r("ready"))),
    );
    const { store, s } = setup({ regenerate });
    await store.claimOnDemand(G, 3);
    await store.markStale(G);
    s.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(regenerate).toHaveBeenCalledTimes(1);
    finish();
    await s.stop();
  });

  it("the recall sweep runs each tick; a sweep or regeneration error is logged, not thrown", async () => {
    const { store, s, sweep, logger, regenerate } = setup();
    sweep.mockRejectedValueOnce(new Error("db down"));
    regenerate.mockRejectedValueOnce(new Error("boom ok_g"));
    await store.claimOnDemand(G, 3);
    await store.markStale(G);
    s.start();
    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("ok_g");
    await s.stop();
  });

  it("stop clears the timer: no tick after stop", async () => {
    const { s, sweep } = setup();
    s.start();
    await vi.advanceTimersByTimeAsync(1 * MIN);
    await s.stop();
    const n = sweep.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(sweep.mock.calls.length).toBe(n);
  });
});
