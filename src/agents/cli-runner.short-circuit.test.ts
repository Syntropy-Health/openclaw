/**
 * mono #538 review: CLI-provider runs fired no plugin hooks, so `/model
 * <cli-provider>` bypassed the hard gate. runCliAgent now honours
 * shortCircuitReply before spawning anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runCliAgent } from "./cli-runner.js";

const spawn = vi.fn();
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: (...args: unknown[]) => spawn(...args),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: vi.fn() }));

function hooks(result: Record<string, unknown> | undefined) {
  vi.mocked(getGlobalHookRunner).mockReturnValue({
    hasHooks: (n: string) => n === "before_agent_start",
    runBeforeAgentStart: vi.fn(async () => result),
  } as unknown as ReturnType<typeof getGlobalHookRunner>);
}

const base = {
  sessionId: "s",
  sessionKey: "agent:main:sms:direct:+15550000000",
  sessionFile: "/tmp/s.json",
  workspaceDir: "/tmp",
  prompt: "hi",
  provider: "claude-cli",
  timeoutMs: 1000,
  runId: "r",
};

describe("runCliAgent honours shortCircuitReply (mono #538 review)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a gated CLI run returns the gate text and spawns NO process (no model)", async () => {
    hooks({ shortCircuitReply: "GATE" });
    const res = await runCliAgent(base);
    expect(res.payloads).toEqual([{ text: "GATE" }]);
    expect(res.meta.shortCircuited).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it("a blank reply does not short-circuit (the run proceeds to the backend)", async () => {
    hooks({ shortCircuitReply: "  " });
    await expect(runCliAgent({ ...base, provider: "no-such-cli" })).rejects.toThrow(
      /Unknown CLI backend/,
    );
  });
});
