import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";

// Channel endpoints and the canvas host are operator surfaces: only an operator
// auth method is admitted there (an end-user sign-in, an unknown method or no
// method is refused); operator credentials pass.

const auth = vi.hoisted(() => ({
  result: { ok: true, method: "token" } as Record<string, unknown>,
}));
vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return { ...actual, authorizeGatewayConnect: async () => auth.result };
});

const { attachGatewayUpgradeHandler, createGatewayHttpServer } = await import("./server-http.js");
const { withTempConfig } = await import("./test-temp-config.js");

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

function request(path: string): IncomingMessage {
  return {
    method: "GET",
    url: path,
    headers: { host: "gateway.example.test", authorization: "Bearer presented" },
    // Not a loopback client, so the canvas host does not admit it as local.
    socket: { remoteAddress: "203.0.113.5" },
  } as unknown as IncomingMessage;
}

function response() {
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
  return res;
}

async function dispatch(server: ReturnType<typeof createGatewayHttpServer>, path: string) {
  const res = response();
  server.emit("request", request(path), res);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

const CLERK = { ok: true, method: "clerk-jwt", externalId: "user_A" };
const NOT_OPERATOR = [
  ["end user", CLERK],
  ["unknown method", { ok: true, method: "future-end-user" }],
  ["no method", { ok: true }],
] as const;
const OPERATOR = { ok: true, method: "token" };

beforeEach(() => {
  auth.result = OPERATOR;
});

function makeServer(handlers: {
  plugin?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  canvas?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}) {
  return createGatewayHttpServer({
    canvasHost: handlers.canvas
      ? ({ rootDir: "/nonexistent", handleHttpRequest: handlers.canvas } as never)
      : null,
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    handlePluginRequest: handlers.plugin,
    resolvedAuth,
  });
}

const served = async (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 200;
  res.end("ok");
  return true;
};

describe.each(NOT_OPERATOR)("operator surfaces refuse a non-operator (%s)", (_label, result) => {
  test("/api/channels/*: refused before the channel handler runs; operator passes", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-operator-surfaces-",
      run: async () => {
        const plugin = vi.fn(served);
        const server = makeServer({ plugin });

        auth.result = result;
        const refused = await dispatch(server, "/api/channels/nostr/default/profile");
        expect(refused.statusCode).toBe(403);
        expect(plugin).not.toHaveBeenCalled();

        auth.result = OPERATOR;
        const allowed = await dispatch(server, "/api/channels/nostr/default/profile");
        expect(allowed.statusCode).toBe(200);
        expect(plugin).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("canvas host: refused before the canvas handler runs; operator passes", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-operator-surfaces-",
      run: async () => {
        const canvas = vi.fn(served);
        const server = makeServer({ canvas });

        auth.result = result;
        const refused = await dispatch(server, "/__openclaw__/canvas/index.html");
        expect(refused.statusCode).toBe(401);
        expect(canvas).not.toHaveBeenCalled();

        auth.result = OPERATOR;
        const allowed = await dispatch(server, "/__openclaw__/canvas/index.html");
        expect(allowed.statusCode).toBe(200);
        expect(canvas).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("canvas WS upgrade: refused before the canvas upgrade runs; operator passes", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-operator-surfaces-",
      run: async () => {
        const handleUpgrade = vi.fn(() => true);
        const httpServer = makeServer({});
        const wss = { handleUpgrade: vi.fn(), emit: vi.fn() };
        attachGatewayUpgradeHandler({
          httpServer,
          wss: wss as never,
          canvasHost: { rootDir: "/nonexistent", handleUpgrade } as never,
          clients: new Set(),
          resolvedAuth,
        });
        const upgrade = async () => {
          const socket = { write: vi.fn(), destroy: vi.fn() };
          httpServer.emit("upgrade", request("/__openclaw__/ws"), socket, Buffer.alloc(0));
          await new Promise((resolve) => setImmediate(resolve));
          return socket;
        };

        auth.result = result;
        const refused = await upgrade();
        expect(String(refused.write.mock.calls[0]?.[0])).toContain("401");
        expect(refused.destroy).toHaveBeenCalled();
        expect(handleUpgrade).not.toHaveBeenCalled();

        auth.result = OPERATOR;
        await upgrade();
        expect(handleUpgrade).toHaveBeenCalledTimes(1);
      },
    });
  });
});
