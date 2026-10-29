/**
 * before_agent_start fires ONCE per run (a turn), however many attempts the run
 * makes (retries, compaction). run.ts calls it early; every attempt reuses that
 * result, and an attempt runs the hook itself only when the early call did not
 * run or threw. Before this fix, "every hook returned nothing" (undefined) looked
 * like "no early result", so every hook ran again in each attempt — without a
 * run id.
 */
import "./run.overflow-compaction.mocks.shared.js";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/types.js";
import { compactEmbeddedPiSessionDirect } from "./compact.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import { runEmbeddedAttempt } from "./run/attempt.js";
import { attemptHookContext, resolveAttemptHookResult } from "./run/before-agent-start.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: vi.fn() }));

type Runner = NonNullable<ReturnType<typeof getGlobalHookRunner>>;

/** A hook runner whose handlers return `result` (or throw on the first call). */
function runner(result: unknown, opts: { throwFirst?: boolean } = {}) {
  const calls: PluginHookAgentContext[] = [];
  const r = {
    hasHooks: (n: string) => n === "before_agent_start",
    runBeforeAgentStart: vi.fn(async (_e: unknown, ctx: PluginHookAgentContext) => {
      calls.push(ctx);
      if (opts.throwFirst && calls.length === 1) {
        throw new Error("runner failed");
      }
      return result;
    }),
  };
  vi.mocked(getGlobalHookRunner).mockReturnValue(r as unknown as Runner);
  return { r, calls };
}

/** The attempt's hook step, driven by exactly the params run.ts hands the attempt. */
function attemptRunsHookStep() {
  vi.mocked(runEmbeddedAttempt).mockImplementation(async (p) => {
    await resolveAttemptHookResult({
      earlyHookRan: p.earlyHookRan === true,
      earlyHookResult: p.earlyHookResult,
      hookRunner: getGlobalHookRunner(),
      event: { prompt: p.prompt },
      ctx: attemptHookContext({ sessionKey: p.sessionKey, sessionId: p.sessionId, runId: p.runId }),
      onError: () => {},
    });
    return makeAttemptResult({ promptError: null });
  });
}

const run = () =>
  runEmbeddedPiAgent({
    sessionId: "s",
    sessionKey: "agent:main:webchat:direct:peer-1",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 30000,
    runId: "resp_once",
    messageProvider: "webchat",
  });

describe("before_agent_start runs once per turn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    attemptRunsHookStep();
  });

  it("every hook returning nothing (undefined): exactly ONE call, with the run id", async () => {
    const { r, calls } = runner(undefined);
    await run();
    expect(r.runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(calls[0].runId).toBe("resp_once");
  });

  it("a hook returning a result: exactly one call (reused by the attempt)", async () => {
    const { r } = runner({ prependContext: "x" });
    await run();
    expect(r.runBeforeAgentStart).toHaveBeenCalledTimes(1);
  });

  it("the early call threw: the attempt's fallback runs once, carrying the run id", async () => {
    const { r, calls } = runner(undefined, { throwFirst: true });
    await run();
    expect(r.runBeforeAgentStart).toHaveBeenCalledTimes(2);
    expect(calls[1].runId).toBe("resp_once");
  });

  it("two attempts in one run (an overflow retry) still run the hook ONCE in total", async () => {
    const { r } = runner(undefined);
    const overflow = new Error("request_too_large: Request size exceeds model context window");
    let n = 0;
    vi.mocked(runEmbeddedAttempt).mockImplementation(async (p) => {
      n++;
      await resolveAttemptHookResult({
        earlyHookRan: p.earlyHookRan === true,
        earlyHookResult: p.earlyHookResult,
        hookRunner: getGlobalHookRunner(),
        event: { prompt: p.prompt },
        ctx: attemptHookContext({ runId: p.runId }),
        onError: () => {},
      });
      return makeAttemptResult({ promptError: n === 1 ? overflow : null });
    });
    vi.mocked(compactEmbeddedPiSessionDirect).mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 150000 },
    } as never);
    await run();
    expect(n).toBe(2); // two attempts really ran
    expect(r.runBeforeAgentStart).toHaveBeenCalledTimes(1);
  });

  it("run.ts tells the attempt whether the early call ran", async () => {
    runner(undefined);
    await run();
    expect(vi.mocked(runEmbeddedAttempt).mock.calls[0][0].earlyHookRan).toBe(true);
    vi.clearAllMocks();
    attemptRunsHookStep();
    runner(undefined, { throwFirst: true });
    await run();
    expect(vi.mocked(runEmbeddedAttempt).mock.calls[0][0].earlyHookRan).toBe(false);
  });
});

describe("resolveAttemptHookResult", () => {
  const event = { prompt: "p" };
  it("no hooks registered: no call, no fallback", async () => {
    const hookRunner = { hasHooks: () => false, runBeforeAgentStart: vi.fn() };
    expect(
      await resolveAttemptHookResult({
        earlyHookRan: false,
        hookRunner,
        event,
        ctx: {},
        onError: () => {},
      }),
    ).toEqual({ result: undefined, fallback: false });
    expect(hookRunner.runBeforeAgentStart).not.toHaveBeenCalled();
  });

  it("a fallback that throws is reported and yields no result", async () => {
    const onError = vi.fn();
    const hookRunner = {
      hasHooks: () => true,
      runBeforeAgentStart: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    expect(
      await resolveAttemptHookResult({ earlyHookRan: false, hookRunner, event, ctx: {}, onError }),
    ).toEqual({ result: undefined, fallback: true });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("attemptHookContext carries the run id (RED arm: drop it and this fails)", () => {
    expect(attemptHookContext({ runId: "resp_x", sessionKey: "k" }).runId).toBe("resp_x");
  });
});

// The attempt is not unit-runnable without a live agent session, so its use of
// the step above is pinned at the source (the same practice as system-prompt.hook.test.ts).
/** The source with every comment removed, so a commented-out line can never satisfy a pin. */
function codeOnly(file: string): string {
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return ts.createPrinter({ removeComments: true }).printFile(sf);
}

describe("attempt.ts wiring (source pin)", () => {
  const src = codeOnly(path.join(import.meta.dirname, "run", "attempt.ts"));

  it("control: comments are gone, code is kept", () => {
    expect(src).not.toContain("Reuse the early result");
    expect(src).toContain("resolveAttemptHookResult(");
  });

  it("decides with earlyHookRan, never by `earlyHookResult ??` (which re-ran on undefined)", () => {
    expect(src).not.toMatch(/params\.earlyHookResult\s*\?\?/);
    expect(src).toMatch(
      /resolveAttemptHookResult\(\{\s*earlyHookRan: params\.earlyHookRan === true,\s*earlyHookResult: params\.earlyHookResult,/,
    );
  });

  it("the fallback call's context carries runId: params.runId", () => {
    expect(src).toMatch(/attemptHookContext\(\{[^}]*runId: params\.runId,[^}]*\}\)/);
  });
});
