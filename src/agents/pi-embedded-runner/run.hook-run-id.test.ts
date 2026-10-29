/**
 * The run id reaches before_agent_start (CTO #17031): a plugin keys per-turn state
 * on ctx.runId, which on the OpenResponses path IS response.id. RED arm: drop the
 * pass-through in run.ts and this fails.
 */
import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: vi.fn() }));

describe("runEmbeddedPiAgent → before_agent_start ctx.runId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runEmbeddedAttempt).mockResolvedValue(makeAttemptResult({ promptError: null }));
  });

  it("passes params.runId on the hook context", async () => {
    const runBeforeAgentStart = vi.fn(async () => undefined);
    vi.mocked(getGlobalHookRunner).mockReturnValue({
      hasHooks: (name: string) => name === "before_agent_start",
      runBeforeAgentStart,
    } as unknown as ReturnType<typeof getGlobalHookRunner>);
    await runEmbeddedPiAgent({
      sessionId: "test-session",
      sessionKey: "agent:main:webchat:direct:peer-1",
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp/workspace",
      prompt: "hello",
      timeoutMs: 30000,
      runId: "resp_run_id_probe",
      messageProvider: "webchat",
    });
    expect(runBeforeAgentStart).toHaveBeenCalledTimes(1);
    const ctx = (runBeforeAgentStart.mock.calls[0] as unknown[])[1] as { runId?: string };
    expect(ctx.runId).toBe("resp_run_id_probe");
  });
});
