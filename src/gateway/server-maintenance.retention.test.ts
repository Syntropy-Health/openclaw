/** mono #544 review: the retention runner is actually WIRED into the gateway maintenance timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const maybeRun = vi.fn();
vi.mock("../config/sessions/transcript-retention.js", () => ({
  createTranscriptRetentionRunner: () => ({ maybeRun }),
}));
vi.mock("./server/health-state.js", () => ({ setBroadcastHealthUpdate: vi.fn() }));

const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");

function start(logError = vi.fn()) {
  const t = startGatewayMaintenanceTimers({
    broadcast: vi.fn(),
    nodeSendToAllSubscribed: vi.fn(),
    getPresenceVersion: () => 0,
    getHealthVersion: () => 0,
    refreshGatewayHealthSnapshot: vi.fn(async () => ({}) as never),
    logHealth: { error: logError },
    dedupe: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: { abortedRuns: new Map() },
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    removeChatRun: vi.fn(),
    agentRunSeq: new Map(),
    nodeSendToSession: vi.fn(),
  });
  return { t, logError };
}

describe("gateway maintenance runs transcript retention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    maybeRun.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("first pass ~30s after start (not inline), then on every 60s maintenance tick", () => {
    const { t } = start();
    expect(maybeRun).toHaveBeenCalledTimes(0); // off the startup path
    vi.advanceTimersByTime(30_000);
    expect(maybeRun).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000); // 60s: first tick
    expect(maybeRun).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(maybeRun).toHaveBeenCalledTimes(3);
    clearInterval(t.tickInterval);
    clearInterval(t.healthInterval);
    clearInterval(t.dedupeCleanup);
  });

  it("a throwing sweep is logged and never breaks the tick", () => {
    maybeRun.mockImplementation(() => {
      throw new Error("boom");
    });
    const { t, logError } = start();
    expect(() => vi.advanceTimersByTime(90_000)).not.toThrow();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("transcript retention failed"));
    clearInterval(t.tickInterval);
    clearInterval(t.healthInterval);
    clearInterval(t.dedupeCleanup);
  });
});
