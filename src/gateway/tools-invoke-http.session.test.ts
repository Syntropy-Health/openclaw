import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// /tools/invoke is an operator surface: an end user signed in through Clerk is
// refused there, and operator credentials behave as before.

let cfg: Record<string, unknown> = {};
let authResult: Record<string, unknown> = { ok: true, method: "token" };
const toolSessionKeys: Array<string | undefined> = [];
const executed: string[] = [];

vi.mock("../config/config.js", () => ({ loadConfig: () => cfg }));
vi.mock("../config/sessions.js", () => ({ resolveMainSessionKey: () => "agent:main:main" }));
vi.mock("./auth.js", () => ({ authorizeGatewayConnect: async () => authResult }));
vi.mock("../logger.js", () => ({ logWarn: () => {} }));
vi.mock("../plugins/config-state.js", () => ({ isTestDefaultMemorySlotDisabled: () => false }));
vi.mock("../plugins/tools.js", () => ({ getPluginToolMeta: () => undefined }));
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawTools: (params: { agentSessionKey?: string }) => {
    toolSessionKeys.push(params.agentSessionKey);
    const namedTools = [
      "memory_recall",
      "memory_store",
      "graphiti_search",
      "graphiti_episodes",
      "cron",
      "nodes",
      "message",
      "sessions_history",
    ].map((name) => ({
      name,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        executed.push(name);
        return { ok: true };
      },
    }));
    return [
      ...namedTools,
      {
        name: "session_probe",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          executed.push(params.agentSessionKey ?? "");
          return { ok: true };
        },
      },
    ];
  },
}));

const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");

let port = 0;
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleToolsInvokeHttpRequest(req, res, { auth: { mode: "token", token: "t" } as never });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  cfg = { tools: { allow: ["session_probe"] } };
  toolSessionKeys.length = 0;
  executed.length = 0;
});

async function invoke(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer x", ...headers },
    body: JSON.stringify({ tool: "session_probe", args: {}, ...body }),
  });
}

describe("POST /tools/invoke caller kinds", () => {
  describe("end user (Clerk JWT)", () => {
    beforeEach(() => {
      authResult = { ok: true, method: "clerk-jwt", externalId: "user_A" };
    });

    for (const tool of [
      "cron",
      "nodes",
      "message",
      "sessions_history",
      "memory_store",
      "session_probe",
    ]) {
      it(`${tool}: refused, and no tool is built`, async () => {
        cfg = { tools: { allow: ["session_probe", tool] } };
        const res = await invoke({ tool });
        expect(res.status).toBe(403);
        expect(toolSessionKeys).toEqual([]);
        expect(executed).toEqual([]);
      });
    }

    it("a body sessionKey does not change the outcome", async () => {
      const res = await invoke({ sessionKey: "agent:main:openai-user:user_B" });
      expect(res.status).toBe(403);
      expect(toolSessionKeys).toEqual([]);
      expect(executed).toEqual([]);
    });
  });

  for (const [label, result] of [
    ["an unknown method", { ok: true, method: "future-end-user" }],
    ["no method", { ok: true }],
  ] as const) {
    it(`${label}: refused, and no tool is built`, async () => {
      authResult = result;
      const res = await invoke({});
      expect(res.status).toBe(403);
      expect(toolSessionKeys).toEqual([]);
      expect(executed).toEqual([]);
    });
  }

  describe("operator", () => {
    for (const method of ["token", "password", "trusted-proxy", "tailscale"]) {
      it(`${method}: may name a session`, async () => {
        authResult = { ok: true, method };
        const res = await invoke({ sessionKey: "agent:main:whatsapp:direct:+15550001111" });
        expect(res.status).toBe(200);
        expect(toolSessionKeys).toEqual(["agent:main:whatsapp:direct:+15550001111"]);
      });
    }

    it("token: without a session, the main session is used", async () => {
      authResult = { ok: true, method: "token" };
      const res = await invoke({});
      expect(res.status).toBe(200);
      expect(toolSessionKeys).toEqual(["agent:main:main"]);
    });

    it("token: an allowed core tool runs", async () => {
      authResult = { ok: true, method: "token" };
      cfg = { tools: { allow: ["session_probe", "cron"] } };
      const res = await invoke({ tool: "cron" });
      expect(res.status).toBe(200);
      expect(executed).toEqual(["cron"]);
    });
  });
});

describe("POST /tools/invoke memory tools", () => {
  for (const tool of ["memory_recall", "memory_store", "graphiti_search", "graphiti_episodes"]) {
    it(`${tool}: not invocable over HTTP with no gateway.tools config`, async () => {
      authResult = { ok: true, method: "token" };
      cfg = { tools: { allow: ["session_probe", tool] } };
      const res = await invoke({ tool });
      expect(res.status).toBe(404);
      expect(executed).toEqual([]);
    });
  }

  for (const tool of ["memory_recall", "memory_store", "graphiti_search", "graphiti_episodes"]) {
    it(`${tool}: not invocable over HTTP, even when allowed in tools.allow and gateway.tools.allow`, async () => {
      authResult = { ok: true, method: "token" };
      cfg = {
        tools: { allow: ["session_probe", tool] },
        gateway: { tools: { allow: [tool] } },
      };
      const res = await invoke({ tool, sessionKey: "agent:main:whatsapp:direct:+15550001111" });
      expect(res.status).toBe(404);
      expect(executed).toEqual([]);
    });
  }
});
