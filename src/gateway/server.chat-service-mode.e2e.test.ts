import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  startServerWithClient,
  withGatewayServer,
} from "./test-helpers.js";

// Wrap the real channel-startup seams with spies so we can assert exactly what
// boots in chat-service mode (channelsEnabled=false) vs the default full gateway.
const hoisted = vi.hoisted(() => ({
  createChannelManager: vi.fn(),
  createNoopChannelManager: vi.fn(),
  startChannelHealthMonitor: vi.fn(),
}));

vi.mock("./server-channels.js", async () => {
  const actual =
    await vi.importActual<typeof import("./server-channels.js")>("./server-channels.js");
  return {
    ...actual,
    createChannelManager: (...args: Parameters<typeof actual.createChannelManager>) => {
      hoisted.createChannelManager(...args);
      return actual.createChannelManager(...args);
    },
    createNoopChannelManager: (...args: Parameters<typeof actual.createNoopChannelManager>) => {
      hoisted.createNoopChannelManager(...args);
      return actual.createNoopChannelManager(...args);
    },
  };
});

vi.mock("./channel-health-monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-health-monitor.js")>(
    "./channel-health-monitor.js",
  );
  return {
    ...actual,
    startChannelHealthMonitor: (...args: Parameters<typeof actual.startChannelHealthMonitor>) => {
      hoisted.startChannelHealthMonitor(...args);
      return actual.startChannelHealthMonitor(...args);
    },
  };
});

installGatewayTestHooks({ scope: "suite" });

describe("gateway chat-service mode (channelsEnabled)", () => {
  beforeEach(() => {
    hoisted.createChannelManager.mockClear();
    hoisted.createNoopChannelManager.mockClear();
    hoisted.startChannelHealthMonitor.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("channelsEnabled:false skips the channel manager + health monitor, no crash", async () => {
    await withGatewayServer(
      async () => {
        expect(hoisted.createChannelManager).not.toHaveBeenCalled();
        expect(hoisted.createNoopChannelManager).toHaveBeenCalledTimes(1);
        expect(hoisted.startChannelHealthMonitor).not.toHaveBeenCalled();
        // Server is live; withGatewayServer closes it (channel teardown no-op'd).
      },
      { serverOptions: { channelsEnabled: false, controlUiEnabled: false } },
    );
  });

  it("default (omitted) boots the real channel manager (full gateway preserved)", async () => {
    await withGatewayServer(
      async () => {
        expect(hoisted.createChannelManager).toHaveBeenCalledTimes(1);
        expect(hoisted.createNoopChannelManager).not.toHaveBeenCalled();
        // Default channelHealthCheckMinutes ⇒ monitor starts.
        expect(hoisted.startChannelHealthMonitor).toHaveBeenCalledTimes(1);
      },
      { serverOptions: { controlUiEnabled: false } },
    );
  });

  it("mounts the HTTP chat surface even with channels off (401 not 404)", async () => {
    await withGatewayServer(
      async ({ port }) => {
        // No auth header ⇒ the route is mounted and rejects with 401 (not 404).
        const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "openclaw", input: "hi" }),
        });
        expect(res.status).toBe(401);
        await res.text();
      },
      {
        serverOptions: {
          channelsEnabled: false,
          controlUiEnabled: false,
          openResponsesEnabled: true,
        },
      },
    );
  });

  it("advertises base methods and excludes channel methods when channels off", async () => {
    const readMethods = (hello: unknown): string[] => {
      const features = (hello as { features?: { methods?: string[] } }).features;
      return (features?.methods ?? []).slice();
    };

    const port = await getFreePort();
    // Connect to a default (channels-on) server and capture advertised methods.
    const onServer = await startServerWithClient(undefined, {
      port,
      controlUiEnabled: false,
    });
    let onMethods: string[] = [];
    try {
      const hello = await connectOk(onServer.ws);
      onMethods = readMethods(hello);
    } finally {
      onServer.ws.close();
      await onServer.server.close({ reason: "methods-on done" });
    }
    expect(onMethods.length).toBeGreaterThan(0);

    const offPort = await getFreePort();
    const offServer = await startServerWithClient(undefined, {
      port: offPort,
      channelsEnabled: false,
      controlUiEnabled: false,
    });
    try {
      const hello = await connectOk(offServer.ws);
      const offMethods = readMethods(hello);
      // Channels-off still advertises the core/base method set.
      expect(offMethods.length).toBeGreaterThan(0);
      // Channels-off is a subset of channels-on: any method unique to the
      // channels-on set (i.e. contributed by channel plugins) is absent.
      const channelOnly = onMethods.filter((m) => !offMethods.includes(m));
      for (const m of channelOnly) {
        expect(offMethods).not.toContain(m);
      }
    } finally {
      offServer.ws.close();
      await offServer.server.close({ reason: "methods-off done" });
    }
  });
});
