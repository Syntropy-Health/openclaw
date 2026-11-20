import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { attachGatewayUpgradeHandler, createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

// The canvas host admits a request without credentials when an authorised
// control-plane client is connected from the same private address. That is
// only sound when the address identifies the client: a forwarded request from a
// peer that is not a configured trusted proxy resolves to the proxy's address,
// shared by every client behind it, so it gets no such admission.

const resolvedAuth: ResolvedGatewayAuth = {
  mode: "token",
  token: "test-token",
  password: undefined,
  allowTailscale: false,
};

const PROXY = "10.0.0.5";
const REAL_CLIENT = "10.0.0.7";

function request(path: string, remoteAddress: string, headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url: path,
    headers: { host: "gateway.example.test", ...headers },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function response() {
  return {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

const served = async (_req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 200;
  res.end("ok");
  return true;
};

function setup(clientIp: string) {
  const canvas = vi.fn(served);
  const handleUpgrade = vi.fn(() => true);
  const clients = new Set([{ clientIp }]) as never;
  const httpServer = createGatewayHttpServer({
    canvasHost: { rootDir: "/nonexistent", handleHttpRequest: canvas, handleUpgrade } as never,
    clients,
    controlUiEnabled: false,
    controlUiBasePath: "/__control__",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth,
  });
  attachGatewayUpgradeHandler({
    httpServer,
    wss: { handleUpgrade: vi.fn(), emit: vi.fn() } as never,
    canvasHost: { rootDir: "/nonexistent", handleUpgrade } as never,
    clients,
    resolvedAuth,
  });
  const http = async (req: IncomingMessage) => {
    const res = response();
    httpServer.emit("request", req, res);
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  };
  const upgrade = async (req: IncomingMessage) => {
    const socket = { write: vi.fn(), destroy: vi.fn() };
    httpServer.emit("upgrade", req, socket, Buffer.alloc(0));
    await new Promise((resolve) => setImmediate(resolve));
    return socket;
  };
  return { canvas, handleUpgrade, http, upgrade };
}

const FORWARDING = [
  ["x-forwarded-for", { "x-forwarded-for": "203.0.113.9" }],
  ["x-real-ip", { "x-real-ip": "203.0.113.9" }],
  ["x-forwarded-host", { "x-forwarded-host": "gateway.example.test" }],
] as const;

describe("canvas IP-based admission", () => {
  describe.each(FORWARDING)("forwarded (%s) from a peer that is not a trusted proxy", (_h, fwd) => {
    test("canvas HTTP: refused, the canvas handler does not run", async () => {
      await withTempConfig({
        cfg: { gateway: { trustedProxies: [] } },
        prefix: "openclaw-canvas-ip-",
        run: async () => {
          const { canvas, http } = setup(PROXY);
          const res = await http(request("/__openclaw__/canvas/index.html", PROXY, fwd));
          expect(res.statusCode).toBe(401);
          expect(canvas).not.toHaveBeenCalled();
        },
      });
    });

    test("canvas WS upgrade: refused, the canvas upgrade does not run", async () => {
      await withTempConfig({
        cfg: { gateway: { trustedProxies: [] } },
        prefix: "openclaw-canvas-ip-",
        run: async () => {
          const { handleUpgrade, upgrade } = setup(PROXY);
          const socket = await upgrade(request("/__openclaw__/ws", PROXY, fwd));
          expect(String(socket.write.mock.calls[0]?.[0])).toContain("401");
          expect(socket.destroy).toHaveBeenCalled();
          expect(handleUpgrade).not.toHaveBeenCalled();
        },
      });
    });
  });

  test("a direct private client with no forwarding headers is still admitted", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-canvas-ip-",
      run: async () => {
        const { canvas, handleUpgrade, http, upgrade } = setup(PROXY);
        const res = await http(request("/__openclaw__/canvas/index.html", PROXY));
        expect(res.statusCode).toBe(200);
        expect(canvas).toHaveBeenCalledTimes(1);
        await upgrade(request("/__openclaw__/ws", PROXY));
        expect(handleUpgrade).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("a request through a configured trusted proxy is admitted for its real client", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [PROXY] } },
      prefix: "openclaw-canvas-ip-",
      run: async () => {
        const { canvas, http } = setup(REAL_CLIENT);
        const res = await http(
          request("/__openclaw__/canvas/index.html", PROXY, { "x-forwarded-for": REAL_CLIENT }),
        );
        expect(res.statusCode).toBe(200);
        expect(canvas).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("through a trusted proxy, another real client is not admitted on the proxy's address", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [PROXY] } },
      prefix: "openclaw-canvas-ip-",
      run: async () => {
        const { canvas, http } = setup(PROXY);
        const res = await http(
          request("/__openclaw__/canvas/index.html", PROXY, { "x-forwarded-for": "203.0.113.9" }),
        );
        expect(res.statusCode).toBe(401);
        expect(canvas).not.toHaveBeenCalled();
      },
    });
  });
});

// OPENCLAW_CANVAS_ADDRESS_FALLBACK: the address fallback stays on only when the
// variable is unset or exactly "on"; any other value turns it off.
describe("canvas address fallback switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const run = async (
    value: string | undefined,
    check: (r: { http: number; upgradeOk: boolean }) => void,
  ) => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-canvas-switch-",
      run: async () => {
        if (value !== undefined) {
          vi.stubEnv("OPENCLAW_CANVAS_ADDRESS_FALLBACK", value);
        }
        const { canvas, handleUpgrade, http, upgrade } = setup(PROXY);
        const res = await http(request("/__openclaw__/canvas/index.html", PROXY));
        await upgrade(request("/__openclaw__/ws", PROXY));
        check({
          http: res.statusCode,
          upgradeOk: handleUpgrade.mock.calls.length === 1 && canvas.mock.calls.length <= 1,
        });
      },
    });
  };

  for (const value of [undefined, "on"]) {
    test(`${value === undefined ? "unset" : JSON.stringify(value)}: a direct private client is admitted (HTTP and upgrade)`, async () => {
      await run(value, (r) => {
        expect(r.http).toBe(200);
        expect(r.upgradeOk).toBe(true);
      });
    });
  }

  for (const value of ["off", "false", "0", "no", "", "ON", "On", " on", "bogus"]) {
    test(`${JSON.stringify(value)}: a direct private client is refused (HTTP and upgrade)`, async () => {
      await run(value, (r) => {
        expect(r.http).toBe(401);
        expect(r.upgradeOk).toBe(false);
      });
    });
  }

  test("off: a request with operator credentials is still admitted", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-canvas-switch-",
      run: async () => {
        vi.stubEnv("OPENCLAW_CANVAS_ADDRESS_FALLBACK", "off");
        const { canvas, http } = setup(PROXY);
        const res = await http(
          request("/__openclaw__/canvas/index.html", PROXY, { authorization: "Bearer test-token" }),
        );
        expect(res.statusCode).toBe(200);
        expect(canvas).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("off: a loopback local request is still admitted", async () => {
    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-canvas-switch-",
      run: async () => {
        vi.stubEnv("OPENCLAW_CANVAS_ADDRESS_FALLBACK", "off");
        const { canvas, http } = setup("127.0.0.1");
        const req = {
          method: "GET",
          url: "/__openclaw__/canvas/index.html",
          headers: { host: "localhost" },
          socket: { remoteAddress: "127.0.0.1" },
        } as unknown as IncomingMessage;
        const res = await http(req);
        expect(res.statusCode).toBe(200);
        expect(canvas).toHaveBeenCalledTimes(1);
      },
    });
  });
});
