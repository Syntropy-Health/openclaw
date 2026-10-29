/**
 * CLI-provider runs pass the run id to before_agent_start too (CTO #17031). RED
 * arm: drop the pass-through in cli-runner.ts and this fails.
 */
import { describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { runCliAgent } from "./cli-runner.js";

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: vi.fn(),
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));
vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: vi.fn() }));

describe("runCliAgent → before_agent_start ctx.runId", () => {
  it("passes params.runId on the hook context", async () => {
    const runBeforeAgentStart = vi.fn(async () => ({ shortCircuitReply: "stop" }));
    vi.mocked(getGlobalHookRunner).mockReturnValue({
      hasHooks: (n: string) => n === "before_agent_start",
      runBeforeAgentStart,
    } as unknown as ReturnType<typeof getGlobalHookRunner>);
    await runCliAgent({
      sessionId: "s",
      sessionKey: "agent:main:sms:direct:+15550000000",
      sessionFile: "/tmp/s.json",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      timeoutMs: 1000,
      runId: "run_cli_probe",
    });
    const ctx = (runBeforeAgentStart.mock.calls[0] as unknown[])[1] as { runId?: string };
    expect(ctx.runId).toBe("run_cli_probe");
  });
});
