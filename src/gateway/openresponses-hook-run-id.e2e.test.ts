/**
 * POST /v1/responses: a before_agent_start hook sees ctx.runId === response.id
 * (CTO #17031). The handler runs the agent with runId = response.id; the agent
 * command (mocked by the gateway harness) is forwarded here to the REAL embedded
 * runner, which fires the REAL global hook runner. The hook short-circuits, so no
 * model is resolved or called.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEmbeddedPiAgent } from "../agents/pi-embedded-runner/run.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentStartResult,
  TypedPluginHookRegistration,
} from "../plugins/types.js";
import { agentCommand, getFreePort, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

afterEach(() => resetGlobalHookRunner());

async function startServer(port: number) {
  const { startGatewayServer } = await import("./server.js");
  return await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token: "secret" },
    controlUiEnabled: false,
    openResponsesEnabled: true,
  } as const);
}

describe("OpenResponses → before_agent_start ctx.runId", () => {
  it("the hook's ctx.runId equals the response id the client receives", async () => {
    const seen: PluginHookAgentContext[] = [];
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "run-id-probe",
      hookName: "before_agent_start",
      handler: (_event: unknown, ctx: PluginHookAgentContext): PluginHookBeforeAgentStartResult => {
        seen.push(ctx);
        return { shortCircuitReply: "probe reply" };
      },
      source: "test",
    } as TypedPluginHookRegistration);
    initializeGlobalHookRunner(registry);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-run-id-"));
    agentCommand.mockReset();
    agentCommand.mockImplementation((async (opts: {
      message: string;
      runId: string;
      sessionKey?: string;
    }) =>
      runEmbeddedPiAgent({
        sessionId: "run-id-session",
        sessionKey: opts.sessionKey,
        sessionFile: path.join(tmp, "session.jsonl"),
        workspaceDir: tmp,
        agentDir: tmp,
        prompt: opts.message,
        timeoutMs: 5_000,
        runId: opts.runId,
      })) as never);

    const port = await getFreePort();
    const server = await startServer(port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ stream: false, model: "openclaw", input: "hello there" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id?: string };
      expect(body.id).toMatch(/^resp_/);
      expect(seen).toHaveLength(1);
      expect(seen[0].runId).toBe(body.id);
    } finally {
      await server.close({ reason: "test done" });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
