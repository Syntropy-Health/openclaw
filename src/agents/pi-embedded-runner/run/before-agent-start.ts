/**
 * before_agent_start inside an attempt. run.ts fires the hook EARLY (so plugins
 * can override the model); the attempt reuses that result. It runs the hook
 * itself only as a FALLBACK, when the early call did not run (no hooks were
 * registered then) or threw.
 *
 * "The early call ran and every handler returned nothing" is a result, not a
 * missing one: running again would fire every hook twice per turn (a memory
 * plugin would search twice and inject facts it never recorded).
 *
 * So a handler that throws in the early call is NOT retried here. That is
 * intended: the hook runner isolates handler errors (catches and logs each, and
 * runs the rest), so the early call still ran. Only a throw of the runner call
 * itself leaves earlyHookRan false and falls back to one call here.
 *
 * The decision is per run: every attempt of a run (retries, compaction) reuses
 * the same early result, so the hook fires once per run.
 */
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookBeforeAgentStartResult,
} from "../../../plugins/types.js";

type HookRunnerLike = {
  hasHooks(name: "before_agent_start"): boolean;
  runBeforeAgentStart(
    event: PluginHookBeforeAgentStartEvent,
    ctx: PluginHookAgentContext,
  ): Promise<PluginHookBeforeAgentStartResult | undefined>;
};

/** The fallback call's context: the same fields as the early call, run id included. */
export function attemptHookContext(p: {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  senderE164?: string | null;
  externalId?: string | null;
  deviceId?: string | null;
}): PluginHookAgentContext {
  return {
    agentId: p.agentId,
    sessionKey: p.sessionKey,
    sessionId: p.sessionId,
    runId: p.runId,
    workspaceDir: p.workspaceDir,
    messageProvider: p.messageProvider,
    senderE164: p.senderE164,
    externalId: p.externalId,
    deviceId: p.deviceId,
  };
}

export async function resolveAttemptHookResult(opts: {
  /** True when run.ts called the hook runner and the call did not throw. */
  earlyHookRan: boolean;
  earlyHookResult?: PluginHookBeforeAgentStartResult;
  hookRunner: HookRunnerLike | null | undefined;
  event: PluginHookBeforeAgentStartEvent;
  ctx: PluginHookAgentContext;
  onError: (err: unknown) => void;
}): Promise<{ result: PluginHookBeforeAgentStartResult | undefined; fallback: boolean }> {
  if (opts.earlyHookRan) {
    return { result: opts.earlyHookResult, fallback: false };
  }
  if (!opts.hookRunner?.hasHooks("before_agent_start")) {
    return { result: undefined, fallback: false };
  }
  try {
    return {
      result: await opts.hookRunner.runBeforeAgentStart(opts.event, opts.ctx),
      fallback: true,
    };
  } catch (err) {
    opts.onError(err);
    return { result: undefined, fallback: true };
  }
}
