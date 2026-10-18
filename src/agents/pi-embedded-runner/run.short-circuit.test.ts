/**
 * mono #538 — `shortCircuitReply` on the before_agent_start result ends the run
 * WITHOUT the model. RED arm (CTO #15017): assert ZERO model calls, not just the
 * reply text: no model is resolved and no attempt (the model call) is run.
 * Absent field = no behaviour change (pinned).
 */
import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveModel } from "./model.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(),
}));

const mockedAttempt = vi.mocked(runEmbeddedAttempt);
const mockedResolveModel = vi.mocked(resolveModel);
const mockedHookRunner = vi.mocked(getGlobalHookRunner);

function hookRunnerReturning(result: Record<string, unknown> | undefined) {
  const runBeforeAgentStart = vi.fn(async () => result);
  mockedHookRunner.mockReturnValue({
    hasHooks: (name: string) => name === "before_agent_start",
    runBeforeAgentStart,
  } as unknown as ReturnType<typeof getGlobalHookRunner>);
  return runBeforeAgentStart;
}

function run(messageProvider: string) {
  return runEmbeddedPiAgent({
    sessionId: "test-session",
    sessionKey: `agent:main:${messageProvider}:direct:peer-1`,
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 30000,
    runId: "run-sc",
    messageProvider,
  });
}

describe("before_agent_start shortCircuitReply (mono #538)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAttempt.mockResolvedValue(makeAttemptResult({ promptError: null }));
  });

  for (const surface of ["webchat", "sms"]) {
    it(`${surface}: replies with the hook text and makes ZERO model calls`, async () => {
      const hook = hookRunnerReturning({
        prependContext: "[IDENTITY_GATE]…",
        shortCircuitReply: "GATE MESSAGE",
      });
      const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
      const result = await runEmbeddedPiAgent({
        sessionId: "test-session",
        sessionKey: `agent:main:${surface}:direct:peer-1`,
        sessionFile: "/tmp/session.json",
        workspaceDir: "/tmp/workspace",
        prompt: "hello",
        timeoutMs: 30000,
        runId: "run-sc",
        messageProvider: surface,
        onAgentEvent: (e) => events.push(e),
      });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(result.payloads).toEqual([{ text: "GATE MESSAGE" }]);
      expect(result.meta.shortCircuited).toBe(true);
      // streaming /v1/responses, chat completions and WS chat.send read these:
      expect(events.map((e) => `${e.stream}:${String(e.data.phase ?? e.data.text)}`)).toEqual([
        "lifecycle:start",
        "assistant:GATE MESSAGE",
        "lifecycle:end",
      ]);
      expect(mockedAttempt).toHaveBeenCalledTimes(0); // the model call
      expect(mockedResolveModel).toHaveBeenCalledTimes(0); // not even resolved
    });
  }

  it("absent shortCircuitReply changes nothing: the model runs", async () => {
    hookRunnerReturning({ prependContext: "[MEMORY_SCOPE]…" });
    await run("webchat");
    expect(mockedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedResolveModel).toHaveBeenCalledTimes(1);
  });

  it("a hook returning nothing changes nothing", async () => {
    hookRunnerReturning(undefined);
    await run("sms");
    expect(mockedAttempt).toHaveBeenCalledTimes(1);
  });

  it("a blank shortCircuitReply does not short-circuit (no empty reply)", async () => {
    hookRunnerReturning({ shortCircuitReply: "   " });
    await run("sms");
    expect(mockedAttempt).toHaveBeenCalledTimes(1);
  });
});
